/**
 * public/js/integrations-monitoring.js — the integration Monitoring
 * tab: the FortiGates credential pickers, the per-class stream subtabs
 * (_CLASS_SUBTAB_SPECS, _isWsSrvRichType), the auto-monitor interface /
 * storage cards and agent deploy, Geographic Location, monitorSettingsFormHTML
 * and every wire / read helper the Add and Edit flows run over it.
 *
 * Split out of integrations.js (CQ-F051) as a byte-for-byte move. A plain
 * browser script: its functions and `var`s are page globals. Loads AFTER
 * integrations.js — tests/unit/integrationsSplit.test.ts holds the order.
 */

// Per-integration monitoring transport block rendered at the top of the
// FortiGates subtab on the Monitoring tab. Renders an SNMP credential picker
// plus four checkboxes that decide which streams (response-time, telemetry,
// interfaces, LLDP) ride SNMP vs the default FortiOS REST API. IPsec is always
// REST regardless — SNMP has no equivalent.
// SNMP / SSH credential pickers for the FortiGates subtab on FMG/FortiGate
// integration modals. Per-stream polling-method selection (REST API / SNMP /
// SSH / ICMP) lives in the Cadence & Retention section above; these pickers
// supply the credentials the SNMP- or SSH-keyed streams will use. A per-asset
// monitorCredential on the Asset's Monitoring tab takes priority.
//
// Both rows are rendered with `display:none` and revealed reactively by
// _syncCredentialPickerVisibility() based on which polling methods are
// currently selected on the four tier dropdowns.
function integrationMonitorOverrideHTML(credentials, selectedSnmpId, selectedSshId) {
  function row(type, label, selectId, selectedId) {
    var creds = (credentials || []).filter(function (c) { return c.type === type; });
    var options = '<option value="">— none —</option>' +
      creds.map(function (c) {
        var sel = (selectedId && c.id === selectedId) ? " selected" : "";
        return '<option value="' + escapeHtml(c.id) + '"' + sel + '>' + escapeHtml(c.name) + '</option>';
      }).join("");
    var emptyHint = creds.length === 0
      ? '<p class="hint" style="color:var(--color-warning)">No ' + escapeHtml(label) + ' credentials defined yet — add one under Server Settings &gt; Credentials.</p>'
      : '<p class="hint">Used by every stream above whose polling method is ' + escapeHtml(label) + '. A per-asset credential on the Asset Monitoring tab takes precedence when set.</p>';
    return '<div class="form-group" id="' + selectId + '-row" style="display:none">' +
        '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.4rem">' + escapeHtml(label) + ' credential</p>' +
        '<select id="' + selectId + '">' + options + '</select>' +
        emptyHint +
      '</div>';
  }
  return row("snmp", "SNMP", "f-mon-credential",     selectedSnmpId) +
         row("ssh",  "SSH",  "f-mon-credential-ssh", selectedSshId)  +
    formDivider();
}

// Build a per-class timer block. The id prefix lets the FortiGate /
// FortiSwitch / FortiAP subtabs each use their own DOM ids while sharing
// the same field set. `defaults` is the FortiGate (top-level) class so
// the FortiSwitch / FortiAP subtabs render the same defaults the operator
// would see if they hadn't customized anything yet.
// ─── Phase 1 monitoring redesign — class subtabs + per-stream subtabs ──────
//
// The new Monitoring tab is organised as:
//   Class subtabs (FortiGate / FortiSwitch / FortiAP for FMG+FortiGate,
//                  Workstations / Servers for AD+Entra+WinSrv)
//     └── Stream subtabs (Response Time / CPU+Memory / Temperature /
//                         Interfaces / LLDP / Storage — Storage absent on
//                         FortiAP)
//          └── Polling method + credential + interval + timeout
//                                + failure threshold (Response Time only)
//
// In Phase 1 every class subtab reads + writes the SAME shared
// `Integration.config.monitorSettings` JSON. The PRIMARY class subtab
// (FortiGate for FMG/FortiGate, Workstations for AD/Entra/WinSrv) uses the
// legacy `f-mon-tier-...` / `f-mon-...` DOM ids so the existing
// `_readIntegrationCadenceForm()` save path keeps working unchanged. Other
// class subtabs use namespaced ids (`f-mon-classecho-<klass>-...`) so the
// inputs render with real values but don't collide on save. The banner inside
// the secondary subtabs warns operators that those values currently mirror
// the primary subtab.
//
// Phase 2 lands the per-class data model + migration + Assets-page narrowing
// after the layout has been reviewed in the demo.

// Per-integration-type class subtab metadata. `primary` names the class whose
// subtab uses the canonical `f-mon-tier-` / `f-mon-` DOM ids — i.e. the one
// whose stream values are actually saved in Phase 1.
var _CLASS_SUBTAB_SPECS = {
  fortimanager: {
    primary: "fortigate",
    classes: [
      { key: "fortigate",   label: "FortiGate"    },
      { key: "fortiswitch", label: "FortiSwitch"  },
      { key: "fortiap",     label: "FortiAP"      },
    ],
  },
  fortigate: {
    primary: "fortigate",
    classes: [
      { key: "fortigate",   label: "FortiGate"    },
      { key: "fortiswitch", label: "FortiSwitch"  },
      { key: "fortiap",     label: "FortiAP"      },
    ],
  },
  activedirectory: {
    primary: "workstations",
    classes: [
      { key: "workstations", label: "Workstations" },
      { key: "servers",      label: "Servers"      },
    ],
  },
  entraid: {
    primary: "workstations",
    classes: [
      { key: "workstations", label: "Workstations" },
      { key: "servers",      label: "Servers"      },
    ],
  },
  windowsserver: {
    primary: "workstations",
    classes: [
      { key: "workstations", label: "Workstations" },
      { key: "servers",      label: "Servers"      },
    ],
  },
  azurearc: {
    primary: "workstations",
    classes: [
      { key: "workstations", label: "Workstations" },
      { key: "servers",      label: "Servers"      },
      // Phase 4. Renders whether or not the operator enabled cluster
      // discovery — the class block has to be editable BEFORE the first run
      // brings clusters in, or addAsMonitored could never be set in advance.
      { key: "clusters",     label: "Kubernetes"   },
    ],
  },
  vcenter: {
    primary: "vms",
    classes: [
      { key: "vms",   label: "Virtual Machines" },
      { key: "hosts", label: "ESXi Hosts"       },
    ],
  },
  // Unraid / TrueNAS SCALE: their own class keys (not vCenter's "vms" /
  // "hosts") so the subtabs render the REDUCED card — addAsMonitored only;
  // no agent deploy or auto-monitor pins — matching WorkloadConfigSchema.
  unraid: {
    primary: "wlhosts",
    classes: [
      { key: "wlhosts",    label: "Host"             },
      { key: "wlvms",      label: "Virtual Machines" },
      { key: "containers", label: "Containers"       },
    ],
  },
  truenas: {
    primary: "wlhosts",
    classes: [
      { key: "wlhosts",    label: "Host"             },
      { key: "wlvms",      label: "Virtual Machines" },
      { key: "containers", label: "Apps"             },
    ],
  },
  proxmox: {
    primary: "wlhosts",
    classes: [
      { key: "wlhosts",    label: "Nodes"            },
      { key: "wlvms",      label: "Virtual Machines" },
      { key: "containers", label: "Containers"       },
    ],
  },
};

// Integration types whose Workstations/Servers class subtabs carry the FULL
// card set (agent auto-deploy + interface/storage auto-monitor), as opposed
// to windowsserver's addAsMonitored-only card. Three separate places used to
// retype this membership list -- the auto-monitor seed stash, the card
// renderer, and the addAsMonitored reveal wiring -- and any two of them
// drifting apart is what produces "the cards render but saved selections
// don't seed". One predicate, three callers.
function _isWsSrvRichType(t) {
  return t === "activedirectory" || t === "entraid" || t === "azurearc";
}

// Streams rendered inside each class subtab. Each entry names:
//   pollField   — legacy poll-method field on monitorSettings (driver of the
//                 polling dropdown id `f-mon-tier-<pollField>`)
//   mibStreamKey — key in _polarisReadMibFourStream's output (responseTime,
//                  telemetry, temperature, interfaces, lldp); MIB select id
//                  is `f-mon-tier-<mibStreamKey>Mib`
//   intervalField / timeoutField — field name on monitorSettings; legacy id
//                  is `f-mon-<intervalField>`, `f-mon-<timeoutField>`. NULL
//                  on lldp + storage — they share systemInfo cadence with
//                  interfaces and the cadence inputs render only on
//                  interfaces. The save reader (_readIntegrationCadenceForm)
//                  already reads systemInfoIntervalSeconds + Timeout once.
// FortiAP omits Storage — APs don't expose mountable storage.
// Phase 1 LLDP + Storage carry their own intervalField / timeoutField. The
// backend resolver doesn't consume these yet (LLDP + Storage continue to
// ride systemInfo cadence at runtime); Phase 2 wires the actual cadence
// dispatch and queue carve-out. Persisted today so the operator's choice
// survives the cutover.
var _ALL_STREAMS = [
  { key: "responseTime", label: "Response Time", pollField: "responseTimePolling", mibStreamKey: "responseTime", intervalField: "intervalSeconds",            timeoutField: "probeTimeoutMs" },
  { key: "cpuMemory",    label: "CPU/Memory",    pollField: "cpuMemoryPolling",    mibStreamKey: "telemetry",    intervalField: "cpuMemoryIntervalSeconds",   timeoutField: "cpuMemoryTimeoutMs"   },
  { key: "temperature",  label: "Hardware Sensors", pollField: "temperaturePolling",  mibStreamKey: "temperature",  intervalField: "temperatureIntervalSeconds", timeoutField: "temperatureTimeoutMs" },
  { key: "interfaces",   label: "Interfaces",    pollField: "interfacesPolling",   mibStreamKey: "interfaces",   intervalField: "systemInfoIntervalSeconds",  timeoutField: "systemInfoTimeoutMs", sharesCadenceWith: null },
  { key: "lldp",         label: "LLDP",          pollField: "lldpPolling",         mibStreamKey: "lldp",         intervalField: "lldpIntervalSeconds",        timeoutField: "lldpTimeoutMs"        },
  { key: "storage",      label: "Storage",       pollField: "storagePolling",      mibStreamKey: null,           intervalField: "storageIntervalSeconds",     timeoutField: "storageTimeoutMs",    noMib: true },
  { key: "processes",    label: "Processes",     pollField: "processesPolling",    mibStreamKey: "processes",    intervalField: "processesIntervalSeconds",   timeoutField: "processesTimeoutMs" },
  { key: "eventLog",     label: "Event Log",     pollField: "eventLogPolling",     mibStreamKey: null,           intervalField: "eventLogIntervalSeconds",    timeoutField: "eventLogTimeoutMs",   noMib: true },
];

// Phase 2 — pick the saved per-class `streams` block matching this class
// subtab, from the `opts` object passed into `_classSubtabBodyHTML`. The
// per-class blocks live on the integration's config at
// `<klass>Monitor.streams` (post-migration); when absent, this returns
// undefined and the overlay falls through to the flat baseline so a
// freshly-edited or unmigrated install still renders sensible values.
function _classStreamsBlockFor(klass, opts) {
  function streamsOf(block) { return block && typeof block === "object" ? block.streams : null; }
  if (klass === "fortigate")    return streamsOf(opts.fortigateMonitor);
  if (klass === "fortiswitch")  return streamsOf(opts.fortiswitchMonitor);
  if (klass === "fortiap")      return streamsOf(opts.fortiapMonitor);
  // _CLASS_SUBTAB_SPECS uses plural class keys for AD/Entra/WinSrv (matches
  // the human-facing tab labels). The backend Integration.config blocks
  // stay singular (workstationMonitor / serverMonitor) so the resolver
  // dispatches on Asset.assetType which is also singular.
  if (klass === "workstations" || klass === "workstation") return streamsOf(opts.workstationMonitor);
  if (klass === "servers"      || klass === "server")      return streamsOf(opts.serverMonitor);
  // vCenter classes: plural UI keys, singular-ish backend blocks
  // (vmMonitor / hostMonitor). "virtual_machine" survives as a klass name
  // only — the VM assets themselves are typed "server".
  if (klass === "vms"   || klass === "virtual_machine") return streamsOf(opts.vmMonitor);
  if (klass === "hosts" || klass === "hypervisor")      return streamsOf(opts.hostMonitor);
  // Azure Arc connected clusters (Phase 4) — reduced block, like hosts.
  if (klass === "clusters" || klass === "kubernetes_cluster") return streamsOf(opts.k8sMonitor);
  // Unraid / TrueNAS classes.
  if (klass === "wlhosts")    return streamsOf(opts.hostMonitor);
  if (klass === "wlvms")      return streamsOf(opts.vmMonitor);
  if (klass === "containers" || klass === "container") return streamsOf(opts.containerMonitor);
  return null;
}

// Phase 2 — overlay a per-class streams block onto the flat baseline so a
// class subtab can show its own saved values. Maps stream cell keys to the
// legacy field names `_classStreamSubtabHTML` consumes from `settings`.
// Returns a shallow-merged copy; never mutates the inputs.
function _classSettingsOverlay(flatSettings, classStreams) {
  var out = Object.assign({}, flatSettings || {});
  if (!classStreams || typeof classStreams !== "object") return out;
  function pickStream(streamKey, fields) {
    var cell = classStreams[streamKey];
    if (!cell || typeof cell !== "object") return;
    if (Object.prototype.hasOwnProperty.call(cell, "polling")          && cell.polling          != null) out[fields.poll]     = cell.polling;
    if (Object.prototype.hasOwnProperty.call(cell, "intervalSeconds")  && cell.intervalSeconds  != null) out[fields.interval] = cell.intervalSeconds;
    if (Object.prototype.hasOwnProperty.call(cell, "timeoutMs")        && cell.timeoutMs        != null) out[fields.timeout]  = cell.timeoutMs;
    if (fields.mib && Object.prototype.hasOwnProperty.call(cell, "mibId")            && cell.mibId  != null) out[fields.mib]      = cell.mibId;
    if (fields.cred && Object.prototype.hasOwnProperty.call(cell, "credentialId")    && cell.credentialId != null) out[fields.cred] = cell.credentialId;
  }
  pickStream("responseTime", { poll: "responseTimePolling", interval: "intervalSeconds",            timeout: "probeTimeoutMs",       mib: "responseTimeMibId", cred: "responseTimeCredentialId" });
  pickStream("cpuMemory",    { poll: "cpuMemoryPolling",    interval: "cpuMemoryIntervalSeconds",   timeout: "cpuMemoryTimeoutMs",   mib: "cpuMemoryMibId",    cred: "cpuMemoryCredentialId" });
  pickStream("temperature",  { poll: "temperaturePolling",  interval: "temperatureIntervalSeconds", timeout: "temperatureTimeoutMs", mib: "temperatureMibId",  cred: "temperatureCredentialId" });
  pickStream("interfaces",   { poll: "interfacesPolling",   interval: "systemInfoIntervalSeconds",  timeout: "systemInfoTimeoutMs",  mib: "interfacesMibId",   cred: "interfacesCredentialId" });
  pickStream("lldp",         { poll: "lldpPolling",         interval: "lldpIntervalSeconds",        timeout: "lldpTimeoutMs",        mib: "lldpMibId",         cred: "lldpCredentialId" });
  // Storage shares the interfaces credential at the backend overlay layer,
  // so the pre-select uses interfacesCredentialId — matching the resolver.
  pickStream("storage",      { poll: "storagePolling",      interval: "storageIntervalSeconds",     timeout: "storageTimeoutMs",     cred: "interfacesCredentialId" });
  pickStream("processes",    { poll: "processesPolling",    interval: "processesIntervalSeconds",   timeout: "processesTimeoutMs",   mib: "processesMibId",    cred: "processesCredentialId" });
  pickStream("eventLog",     { poll: "eventLogPolling",     interval: "eventLogIntervalSeconds",    timeout: "eventLogTimeoutMs",    cred: "eventLogCredentialId" });
  return out;
}

function _streamsForClass(klass) {
  // Cross-transport stream applicability per class:
  //   workstation / server (AD/Entra/Windows) → processes + event log
  //   fortigate                               → event log only (FortiOS device
  //                                              log via REST; no host process API)
  //   fortiswitch / fortiap / other appliances → neither
  // NOTE: the integration Monitoring tab uses PLURAL class keys ("workstations"
  // / "servers"); accept both plural and singular so the subtabs actually render
  // (the asset.assetType the resolver keys off is singular).
  var isHostClass = (klass === "workstation" || klass === "workstations" || klass === "server" || klass === "servers" ||
                     klass === "vms" || klass === "virtual_machine"); // vCenter VMs are guest OSes
  var allowProcesses = isHostClass;
  var allowEventLog  = isHostClass || klass === "fortigate";
  return _ALL_STREAMS.filter(function (s) {
    if (s.key === "storage" && klass === "fortiap") return false; // FortiAP has no mountable storage
    // A connected Kubernetes cluster is an API endpoint, not a host: no
    // mounts to walk. (processes / eventLog are already off — isHostClass
    // excludes it.)
    if (s.key === "storage" && klass === "clusters") return false;
    // A container / App reports state and CPU / memory only — its host's API
    // publishes no interfaces, mounts, sensors or neighbours for it.
    if ((klass === "containers" || klass === "container") &&
        (s.key === "storage" || s.key === "interfaces" || s.key === "lldp" || s.key === "temperature")) return false;
    if (s.key === "processes") return allowProcesses;
    if (s.key === "eventLog")  return allowEventLog;
    return true;
  });
}

// Renders the polling-method + credential + interval + timeout block for ONE
// (class, stream) pair. `idPrefix` namespaces the DOM ids. For the PRIMARY
// class subtab the prefix is empty-ish: polling dropdowns use the legacy
// `f-mon-tier-<pollField>` ids and numeric inputs use `f-mon-<numField>`
// ids so `_readIntegrationCadenceForm()` finds them unchanged. For
// SECONDARY class subtabs (echo of the primary in Phase 1) the prefix
// becomes `f-mon-classecho-<klass>-` and the same suffixes follow — those
// ids exist so the inputs render with the same starting values but never
// get read on save.
function _classStreamSubtabHTML(idPrefix, sourceKind, klass, stream, settings, credentials, isPrimary, opts) {
  settings = settings || {};
  credentials = credentials || [];
  opts = opts || {};
  // opts.showInherit (default true) — pass false at the bottom of the
  // resolver hierarchy (Manual Monitoring) so the polling-method dropdown
  // omits "Inherit". opts.showMib (default true) — pass false on surfaces
  // where the per-stream MIB picker isn't meaningful (also Manual Monitoring
  // in this iteration). opts.showStreamCredentials (default true) — pass
  // false on FortiSwitch + FortiAP class subtabs where the class-level
  // SNMP/SSH credential picker (rendered inside _classDirectPollHTML) is
  // the authoritative source; managed switches and APs use one credential
  // across every stream so the per-stream rows would just duplicate it.
  var showInherit = opts.showInherit !== false;
  var showMib     = opts.showMib     !== false;
  var showStreamCredentials = opts.showStreamCredentials !== false;
  var pollCurrent = settings[stream.pollField] || "";

  // Stream-key → settings field that holds this stream's saved credential
  // id, used both for pre-selecting the dropdown on render and by the read
  // path on save. Storage shares the interfaces credential (mirrors the
  // backend overlay's `storage: { credentialField: "interfacesCredentialId" }`).
  var streamCredField =
    stream.key === "responseTime" ? "responseTimeCredentialId" :
    stream.key === "cpuMemory"    ? "cpuMemoryCredentialId"    :
    stream.key === "temperature"  ? "temperatureCredentialId"  :
    stream.key === "interfaces"   ? "interfacesCredentialId"   :
    stream.key === "lldp"         ? "lldpCredentialId"         :
    stream.key === "storage"      ? "interfacesCredentialId"   :
    stream.key === "processes"    ? "processesCredentialId"    :
    stream.key === "eventLog"     ? "eventLogCredentialId"     :
    null;
  var savedStreamCredId = streamCredField ? (settings[streamCredField] || "") : "";

  // ID composition. The primary subtab uses the legacy naming so the existing
  // _polarisReadPollingFourStream / _polarisReadMibFourStream /
  // _readIntegrationCadenceForm readers find the values without changes.
  var pollId    = isPrimary ? ("f-mon-tier-" + stream.pollField)         : (idPrefix + "tier-" + stream.pollField);
  var mibId     = (stream.mibStreamKey && !stream.noMib)
    ? (isPrimary ? ("f-mon-tier-" + stream.mibStreamKey + "Mib")          : (idPrefix + "tier-" + stream.mibStreamKey + "Mib"))
    : null;
  var mibWrapId = (stream.mibStreamKey && !stream.noMib)
    ? (isPrimary ? ("f-mon-tier-" + stream.mibStreamKey + "-mib-wrap")    : (idPrefix + "tier-" + stream.mibStreamKey + "-mib-wrap"))
    : null;

  // Polling dropdown. Polling stream key fed into _polarisPollingDropdownHTML
  // mirrors the legacy mapping (cpuMemory → telemetry) so the source-default
  // label matches the resolver.
  var pollStreamKeyForDefaults = stream.key === "cpuMemory" ? "telemetry" : stream.key;
  var pollDropdown = _polarisPollingDropdownHTML(pollId, sourceKind, pollStreamKeyForDefaults, pollCurrent, {
    fmgDirectMode: opts.fmgDirectMode === true,
    showInherit:   showInherit,
    klass:         klass,
  });

  // Credential picker. Visibility is reactive — we render the row always and
  // toggle display based on whether the chosen polling method needs creds.
  // Each stream cell carries a `credentialId` field on the backend at
  // config.<klass>Monitor.streams.<stream>.credentialId; we pre-select the
  // matching dropdown when the saved id matches the credential type that
  // pairs with the chosen polling method. When showStreamCredentials is
  // false (FortiSwitch + FortiAP class subtabs), the rows are omitted
  // entirely — the class-level credential picker is the authoritative
  // source there.
  var credRows = "";
  if (showStreamCredentials) {
    ["snmp", "ssh", "winrm"].forEach(function (credType) {
      var label = credType === "winrm" ? "WinRM" : credType.toUpperCase();
      var rows = credentials.filter(function (c) { return c.type === credType; });
      // Pre-select the saved credential only when it actually exists in this
      // credtype's list — guards against the saved value belonging to a
      // different credtype than the currently-chosen polling method (e.g.
      // operator flipped polling from SNMP to SSH; the stored SNMP id stays
      // in settings but the SSH dropdown stays at "Inherit").
      var selectedValue = "";
      if (savedStreamCredId && rows.some(function (c) { return c.id === savedStreamCredId; })) {
        selectedValue = savedStreamCredId;
      }
      var options = '<option value=""' + (selectedValue === "" ? " selected" : "") + '>— Inherit / none —</option>' +
        rows.map(function (c) {
          var sel = c.id === selectedValue ? " selected" : "";
          return '<option value="' + escapeHtml(c.id) + '"' + sel + '>' + escapeHtml(c.name) + '</option>';
        }).join("");
      credRows += '<div class="form-group" id="' + pollId + '-credrow-' + credType + '" style="display:none;margin-bottom:0.5rem">' +
          '<label style="margin:0 0 0.25rem 0;font-size:0.85rem">' + escapeHtml(label) + ' credential</label>' +
          '<select id="' + pollId + '-cred-' + credType + '">' + options + '</select>' +
          (rows.length === 0
            ? '<p class="hint" style="color:var(--color-warning);margin-top:0.25rem">No ' + escapeHtml(label) + ' credentials defined yet — add one under Server Settings &gt; Credentials.</p>'
            : '<p class="hint" style="margin-top:0.25rem">Used when this stream\'s polling method resolves to ' + escapeHtml(label) + '. A per-asset credential takes priority.</p>'
          ) +
        '</div>';
    });
  }

  // Per-stream cadence + timeout. Streams that share systemInfo cadence with
  // Interfaces (LLDP, Storage) skip the inputs and render a shares-cadence
  // hint instead — the underlying systemInfoIntervalSeconds / Timeout fields
  // are edited from the Interfaces subtab.
  function numInput(idSuffix, label, value, defaultValue, min, max, hint, warn500) {
    var fullId = isPrimary ? ("f-mon-" + idSuffix) : (idPrefix + idSuffix);
    var v = (value != null) ? value : defaultValue;
    var warnMarkup = warn500
      ? '<span id="' + fullId + '-warn" style="display:none;font-size:0.75rem;color:var(--color-warning);margin-left:0.5rem">⚠ Below 500 ms — probes will likely false-fail under healthy network conditions.</span>'
      : '';
    return '<div class="form-group"><label>' + escapeHtml(label) + warnMarkup + '</label>' +
      '<input type="number" id="' + fullId + '" value="' + escapeHtml(String(v == null ? "" : v)) + '" min="' + min + '" max="' + max + '" style="width:140px">' +
      (hint ? '<p class="hint">' + hint + '</p>' : '') +
    '</div>';
  }

  var cadenceHtml = "";
  if (stream.sharesCadenceWith) {
    cadenceHtml = '<p class="hint" style="margin:0.25rem 0 0.75rem 0;padding:0.5rem 0.65rem;background:var(--color-bg-tertiary);border-radius:var(--radius-sm);color:var(--color-text-secondary)">' +
      "Cadence + timeout for this stream are shared with the <strong>" + escapeHtml(stream.sharesCadenceWith) + "</strong> subtab. " +
      "An independent " + escapeHtml(stream.key) + " queue + interval ships in the next release." +
    '</p>';
  } else {
    var intervalDefault, intervalMin, intervalMax, timeoutDefault;
    if (stream.key === "responseTime") {
      intervalDefault = 60; intervalMin = 5; intervalMax = 86400; timeoutDefault = 5000;
    } else if (stream.key === "cpuMemory" || stream.key === "temperature") {
      intervalDefault = 60; intervalMin = 15; intervalMax = 86400; timeoutDefault = 10000;
    } else {
      intervalDefault = 600; intervalMin = 60; intervalMax = 86400; timeoutDefault = 10000;
    }
    // The workload class keys are internal names (wlhosts / wlvms) — say what they hold.
    var klassNoun = { wlhosts: "host", wlvms: "virtual machine", vms: "virtual machine", hosts: "host", containers: "container" }[klass] || klass;
    var intervalHint = "How often this stream collects from each monitored " + escapeHtml(klassNoun) + ".";
    var timeoutHint = "Per-request timeout.";
    cadenceHtml = numInput(stream.intervalField, "Interval (seconds)", settings[stream.intervalField], intervalDefault, intervalMin, intervalMax, intervalHint, false) +
      numInput(stream.timeoutField, "Timeout (ms)", settings[stream.timeoutField], timeoutDefault, 100, 120000, timeoutHint, stream.key === "responseTime");
  }

  // How many missed polls make a device Down is NOT set here any more: it
  // belongs to the down-detection automation covering each device (business
  // rule 36), most specific wins. This card still owns the two numbers that
  // decide how LONG each missed poll takes — the interval above and the probe
  // timeout — so the note explains the split rather than leaving the operator
  // to wonder where the threshold went.
  var failureHtml = "";
  if (stream.key === "responseTime") {
    failureHtml = '<div class="form-group" style="padding:0.5rem 0.65rem;background:var(--color-bg-tertiary);border-radius:var(--radius-sm)">' +
      '<label style="margin:0 0 0.25rem 0">Declaring Down</label>' +
      '<p class="hint" style="margin:0">How many missed polls make a device <strong>Down</strong> is set by the ' +
        '<strong>asset-down automation</strong> that covers it — most specific wins. This card sets how OFTEN Polaris ' +
        'polls and how long it waits for an answer; those two decide how long each missed poll takes, not how many ' +
        'of them count.<br>' +
        'A device no down-detection automation covers is <strong>Passive</strong>: still polled and charted, never ' +
        'declared Down. <a href="/automations.html">Manage down detection &rarr;</a></p>' +
    '</div>';
  }

  // Optional per-stream MIB picker (only shown when SNMP is the chosen
  // polling method). The select id matches what _polarisReadMibFourStream
  // already reads (`f-mon-tier-<streamKey>Mib`).
  var mibHtml = "";
  if (mibId && mibWrapId && showMib) {
    var autoName = (_autoMibNamesForSource(sourceKind) || {})[pollStreamKeyForDefaults] || "";
    var mibCurrent = settings[stream.mibStreamKey + "MibId"] || "";
    mibHtml = '<div class="form-group" id="' + mibWrapId + '" style="display:none">' +
        '<label>MIB</label>' +
        '<select id="' + mibId + '" data-current-id="' + escapeHtml(mibCurrent) + '" data-auto-mib-name="' + escapeHtml(autoName) + '" data-mib-picker="1">' +
          _mibOptionsHTML(mibCurrent, autoName) +
        '</select>' +
        "<p class=\"hint\">Defaults to Automatic — Polaris picks the right MIB from the asset's Manufacturer Profile (Server Settings → Credentials → Manufacturer Profiles). Pin a specific module here only when a particular device needs to override its profile.</p>" +
      '</div>';
  }

  // FortiLink LLDP exclusion — an integration-level toggle surfaced directly
  // under the LLDP polling method. Rendered only on the FortiGate primary
  // subtab so there is exactly one checkbox per modal; its value is stored in
  // integration.config.excludeFortilinkLldp and read on save by
  // _readExcludeFortilinkLldpToggle(). The filtering happens at collection time
  // on the backend (monitoringService). FortiOS-only.
  var fortilinkHtml = "";
  if (stream.key === "lldp" && klass === "fortigate" && isPrimary) {
    var flChecked = opts.excludeFortilinkLldp === true ? "checked" : "";
    fortilinkHtml = '<div class="form-group" style="display:flex;align-items:flex-start;gap:8px;margin-top:0.25rem">' +
        '<input type="checkbox" id="f-excludeFortilinkLldp" ' + flChecked + ' style="width:auto;margin-top:3px">' +
        '<div>' +
          '<label for="f-excludeFortilinkLldp" style="margin:0">Exclude FortiLink interfaces from LLDP collection</label>' +
          '<p class="hint" style="margin:0.15rem 0 0 0">When on, Polaris drops LLDP neighbors learned on FortiLink-enabled interfaces (the FortiLink aggregate and its member ports) so internal FortiGate-to-FortiSwitch links stay out of the Neighbor column. Detected from the FortiGate CMDB fortilink flag. Inferred topology rows are unaffected.</p>' +
        '</div>' +
      '</div>';
  }

  return '<div class="form-group"><label>Polling method</label>' + pollDropdown +
      '<p class="hint">Select the protocol Polaris uses for this stream. "Inherit" falls through to the source default.</p>' +
    '</div>' +
    fortilinkHtml +
    credRows +
    cadenceHtml +
    failureHtml +
    mibHtml;
}

// _polarisMonDownAfterSync is gone with the fields it kept in sync: the
// missed-poll count moved to the down-detection automation (business rule 36),
// and the derived duration it wrote back has nothing left to write to here.
// The arithmetic itself lives on in public/js/monitor-down-after.js, which the
// automations wizard and the asset surfaces read.

// Renders the inside of one class subtab (e.g. FortiSwitch) — the optional
// "direct polling" / "discovery defaults" header content first, then the
// stream subtabs. The primary class subtab uses the legacy DOM ids so the
// existing save reader keeps working; secondary subtabs use namespaced ids
// for parallel render-only inputs and surface a banner explaining that
// their values currently mirror the primary subtab.
function _classSubtabBodyHTML(opts) {
  var integrationType = opts.integrationType;
  var klass           = opts.klass;
  var isPrimary       = opts.isPrimary;
  var primaryLabel    = opts.primaryLabel;
  var settings        = opts.settings || {};
  var credentials     = opts.credentials || [];
  var headerHtml      = opts.headerHtml || "";

  // Phase 2: overlay the per-class streams block onto the flat settings
  // baseline so this class subtab shows its own saved per-stream values
  // instead of mirroring the FortiGate / Workstation primary subtab. The
  // per-class block lives at opts.<klass>MonitorConfig.streams.<stream>.
  // Each stream's cells become the same keys the legacy `settings`
  // object carried: `<pollField>` / `<intervalField>` / `<timeoutField>` /
  // `<mibStreamKey>MibId`. Empty fields fall back to
  // the flat baseline so legacy integrations that haven't been migrated
  // yet still render their familiar starting values.
  var perClassSettings = _classSettingsOverlay(settings, opts.classStreams);

  // Phase 1: every non-primary class subtab is an echo of the primary today
  // (the save reader only consumes the primary subtab's namespaced ids). The
  // banner that used to call this out has been removed at the user's request —
  // operators know it's echo-only and don't need the inline reminder.
  var banner = "";

  // Secondary class subtabs get a fully-namespaced id prefix so their inputs
  // don't collide with the primary subtab's legacy ids.
  var echoPrefix = "f-mon-classecho-" + klass + "-";

  // Nested tab strip key per class so two class subtabs in the same modal
  // don't share active stream-tab state.
  var streamTabsPrefix = isPrimary
    ? "intg-mon-streams-primary"
    : "intg-mon-streams-" + klass;

  // fmgDirectMode is the live state of the f-useDirect toggle for fortimanager
  // integrations (true when checked / useProxy=false); for fortigate integrations
  // it's implicitly always direct. Drives the "Inherit (Source FortiGate Direct
  // / FortiManager Proxy: …)" label rendered by _polarisPollingDropdownHTML.
  var initialFmgDirectMode = integrationType === "fortimanager"
    ? ((opts.fmgDefaults || {}).useProxy === false)
    : (integrationType === "fortigate");
  var streams = _streamsForClass(klass);
  var streamTabs = streams.map(function (stream) {
    return {
      key: stream.key,
      label: stream.label,
      html: _classStreamSubtabHTML(echoPrefix, integrationType, klass, stream, perClassSettings, credentials, isPrimary, {
        fmgDirectMode: initialFmgDirectMode,
        showStreamCredentials: opts.showStreamCredentials !== false,
        excludeFortilinkLldp: opts.excludeFortilinkLldp === true,
      }),
    };
  });

  // Stream subtabs are gated by the class's Direct Polling toggle on the
  // FortiSwitch / FortiAP classes, whose toggle really does mean "Polaris talks
  // to these devices directly" — with it off there is nothing to configure.
  //
  // The FMG-FortiGate class is NOT gated that way any more. Its toggle is the
  // TRANSPORT switch, and hiding the whole stream matrix behind it was wrong
  // twice over: monitoring never used the FMG proxy anyway (every FortiOS
  // collector dials the gate directly), and the stored per-stream values stayed
  // in force while nothing was on screen to show or change them. The subtabs now
  // always render for that class, with individual dropdowns locked by
  // _applyFortiosRestLocks when no FortiOS call can be made at all.
  var streamsWrapId = "intg-mon-streams-wrap-" + (isPrimary ? "primary-" : "") + klass;
  var directToggleId = _directPollingToggleIdFor(integrationType, klass);
  var isFmgFortigateClass = integrationType === "fortimanager" && klass === "fortigate";
  if (isFmgFortigateClass) directToggleId = null;
  var initialDirectOn = _directPollingInitialStateFor(integrationType, klass, opts);
  var wrapperHidden = (directToggleId && !initialDirectOn) ? "display:none" : "";

  // Shown only while a FortiOS REST call is impossible. Hidden by default and
  // revealed by _applyFortiosRestLocks so it tracks the live form state rather
  // than the state at render time.
  var restNote = (integrationType === "fortimanager")
    ? '<div data-fortios-rest-note style="display:none;background:color-mix(in srgb, var(--color-warning) 8%, transparent);border:1px solid color-mix(in srgb, var(--color-warning) 35%, transparent);border-radius:var(--radius-md);padding:0.6rem 0.8rem;margin-bottom:0.75rem;font-size:0.85rem;line-height:1.5">' +
        '<strong>REST API methods are locked.</strong> FortiManager proxy mode with no FortiGate API token cannot make a FortiOS call to the device, so these streams fall back to what the integration inherits. ' +
        'Set a <em>FortiGate API Token</em> on the FortiGate subtab above (it applies in both transports), or enable <em>Direct Polling</em>. ' +
        'SNMP and ICMP are unaffected, and per-asset overrides still apply.' +
      '</div>'
    : "";

  return banner +
    headerHtml +
    '<div id="' + streamsWrapId + '" data-direct-toggle="' + escapeHtml(directToggleId || "") + '" style="' + wrapperHidden + '">' +
      restNote +
      tabbedBodyHTML(streamTabsPrefix, streamTabs) +
    '</div>';
}

// Returns the DOM id of the Direct Polling checkbox that gates this class's
// stream subtabs, or null when the class has no such toggle (standalone
// FortiGate's FortiGate subtab, AD / Entra / WindowsServer). The class subtab
// renderer reads this to decide whether to wrap stream subtabs in a hidden
// container; `_wireMonitoringTabSubtabs` reads it to wire the toggle's
// `change` event so flipping it reveals/hides the wrapper.
function _directPollingToggleIdFor(integrationType, klass) {
  if (klass === "fortigate"   && integrationType === "fortimanager") return "f-useDirect";
  if (klass === "fortiswitch" && (integrationType === "fortimanager" || integrationType === "fortigate")) return "f-mon-fortiswitch-enabled";
  if (klass === "fortiap"     && (integrationType === "fortimanager" || integrationType === "fortigate")) return "f-mon-fortiap-enabled";
  return null;
}

// Returns the initial on/off state for the Direct Polling toggle that gates
// this class's stream subtabs. Mirrors the same values the toggle's own
// `checked` attribute is rendered with so the stream wrapper opens in the
// matching state without a JS round-trip.
function _directPollingInitialStateFor(integrationType, klass, opts) {
  if (klass === "fortigate" && integrationType === "fortimanager") {
    return (opts.fmgDefaults || {}).useProxy === false;
  }
  if (klass === "fortiswitch" && (integrationType === "fortimanager" || integrationType === "fortigate")) {
    return (opts.fortiswitchMonitor || {}).enabled === true;
  }
  if (klass === "fortiap" && (integrationType === "fortimanager" || integrationType === "fortigate")) {
    return (opts.fortiapMonitor || {}).enabled === true;
  }
  return true;
}

// "Enable / Disable Auto-Monitoring" button + hint. Replaces the prior
// checkbox to add visual weight to the destructive transition (red
// "Disable" framing). The id `<prefix>addAsMonitored` continues to be
// the source of truth read by the save path; we now stash its boolean
// state on a hidden input of the same id (so the existing _getCheckbox
// reader keeps working) and the visible Button toggles the hidden input
// while updating its own label/color reactively.
//
// The Save Changes path runs a preflight against the proposed addAsMonitored
// values and shows a confirm modal when wouldDisable > 0 on any class —
// see `_promptAutoMonitorAssetsConfirm` below.
// Pluralize a Fortinet kind label for UI copy. The English -es rule covers
// both kinds this card serves: "FortiSwitch" → "FortiSwitches" (ends in -ch),
// "FortiAP" → "FortiAPs".
function _kindPlural(kindLabel) {
  return /(?:s|x|z|ch|sh)$/i.test(kindLabel) ? kindLabel + "es" : kindLabel + "s";
}
function _classAddAsMonitoredHTML(idPrefix, kindLabel, currentAddAsMonitored) {
  var enabled = currentAddAsMonitored === true;
  var btnClass = enabled ? "btn-danger" : "btn-primary";
  var btnLabel = enabled ? "Disable Auto-Monitoring" : "Enable Auto-Monitoring";
  return '<div style="background:color-mix(in srgb, var(--color-accent) 6%, transparent);border:1px solid color-mix(in srgb, var(--color-accent) 20%, transparent);border-radius:var(--radius-md);padding:0.75rem 0.9rem;margin-bottom:1rem">' +
      '<div class="form-group" style="display:flex;align-items:center;gap:12px;margin-bottom:0.4rem">' +
        // Hidden input preserves the existing save-path read pattern (_getCheckbox).
        '<input type="checkbox" id="' + idPrefix + 'addAsMonitored" ' + (enabled ? "checked" : "") + ' style="display:none">' +
        '<button type="button" class="btn ' + btnClass + '" data-auto-monitor-toggle="' + idPrefix + 'addAsMonitored" style="min-width:200px">' + btnLabel + '</button>' +
        '<div style="font-weight:500">Auto-Monitor ' + escapeHtml(_kindPlural(kindLabel)) + '</div>' +
      '</div>' +
      '<p class="hint" style="margin:0">When enabled, every discovered ' + escapeHtml(kindLabel) + ' is monitored. Disabling sweeps existing ' + escapeHtml(_kindPlural(kindLabel)) + ' off monitoring on the next discovery cycle unless an operator has set a per-asset override. You\'ll be asked to confirm at Save Changes.</p>' +
    '</div>';
}

// Picker block for the FortiSwitch / FortiAP subtab — "enable direct polling"
// checkbox + per-credential-type dropdowns (SNMP / SSH). The addAsMonitored
// checkbox used to live here too but was hoisted into
// `_classAddAsMonitoredHTML` so the FortiSwitch / FortiAP subtabs can render
// addAsMonitored at the top of the body. id prefix collides if you
// instantiate twice on the same page; we use distinct prefixes per class.
// The SNMP and SSH rows render hidden and are revealed reactively by
// _syncCredentialPickerVisibility() once the integration-tier polling
// dropdowns pick the matching method.
function _classDirectPollHTML(idPrefix, kindLabel, credentials, currentEnabled, currentSnmpCredId, currentSshCredId) {
  function credRow(type, label, selectId, selectedId) {
    var rows = (credentials || []).filter(function (c) { return c.type === type; });
    var options = '<option value="">— select credential —</option>' +
      rows.map(function (c) {
        var sel = (selectedId && c.id === selectedId) ? " selected" : "";
        return '<option value="' + escapeHtml(c.id) + '"' + sel + '>' + escapeHtml(c.name) + '</option>';
      }).join("");
    var emptyHint = rows.length === 0
      ? '<p class="hint" style="color:var(--color-warning)">No ' + escapeHtml(label) + ' credentials defined yet — add one under Server Settings &gt; Credentials, or leave direct polling off and Polaris will fall back to ICMP when "Add as Monitored" is checked above.</p>'
      : '<p class="hint">Discovery stamps each newly-found ' + escapeHtml(kindLabel) + ' with this credential when ' + escapeHtml(label) + ' is the resolved polling method. Operator overrides on existing assets are preserved.</p>';
    return '<div class="form-group" id="' + selectId + '-row" style="margin-bottom:0.6rem;display:none">' +
        '<label>' + escapeHtml(label) + ' credential</label>' +
        '<select id="' + selectId + '">' + options + '</select>' +
        emptyHint +
      '</div>';
  }
  return sectionHeading("Direct polling") +
    '<div style="background:color-mix(in srgb, var(--color-accent) 8%, transparent);border:1px solid color-mix(in srgb, var(--color-accent) 20%, transparent);border-radius:var(--radius-md);padding:0.75rem 0.9rem;margin-bottom:1rem">' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);line-height:1.5;margin:0 0 0.6rem 0">Managed ' + escapeHtml(_kindPlural(kindLabel)) + ' in FortiLink mode usually keep their own management plane locked down. Polaris can\'t reach them through the controller FortiGate REST API, so direct polling only works when the matching protocol has been explicitly enabled on the ' + escapeHtml(kindLabel) + ' itself.</p>' +
      '<div class="form-group" style="display:flex;align-items:center;gap:8px;margin-bottom:0.6rem">' +
        '<input type="checkbox" id="' + idPrefix + 'enabled" ' + (currentEnabled ? "checked" : "") + ' style="width:auto">' +
        '<label for="' + idPrefix + 'enabled" style="margin:0;font-weight:500">Enable direct polling of managed ' + escapeHtml(_kindPlural(kindLabel)) + '</label>' +
      '</div>' +
      credRow("snmp", "SNMP", idPrefix + "credentialId",    currentSnmpCredId) +
      credRow("ssh",  "SSH",  idPrefix + "sshCredentialId", currentSshCredId)  +
    '</div>';
}

// ─── Auto-Monitor Interfaces card ──────────────────────────────────────────
// Three selection modes; defaults differ per class (FortiGates → names,
// FortiSwitches → wildcard, FortiAPs → type). On the Create modal we don't
// have an integrationId yet, so the live preview + aggregate list are
// suppressed (operator still picks a mode and sets values; the first preview
// happens after Save + first discovery).

// Rough threshold above which Save warns about pin volume. Per-asset isn't
// the issue — the worst case is "type=physical, onlyUp=false" on a fleet of
// 48-port FortiSwitches, which can pin thousands of interfaces all polled
// every ~60s. Tune after observing real DBs.
var AUTO_MONITOR_INTERFACE_WARN_THRESHOLD = 500;

// Frontend mirror of services/autoMonitorInterfacesService.ts:coerceLegacySelection.
// Used when rendering a saved config that hasn't been swept by the one-shot
// migration job yet — keeps the card in sync with whatever shape is in the DB.
function _amonCoerceLegacy(sel) {
  if (!sel || typeof sel !== "object") return null;
  if ("byNames" in sel || "byPatterns" in sel || "byTypes" in sel || "byLldp" in sel) return sel;
  if (sel.mode === "names"    && Array.isArray(sel.names))    return { byNames:    { names: sel.names.slice() } };
  if (sel.mode === "wildcard" && Array.isArray(sel.patterns)) return { byPatterns: { patterns: sel.patterns.slice(), regex: false, onlyUp: sel.onlyUp === true } };
  if (sel.mode === "type"     && Array.isArray(sel.types))    return { byTypes:    { types: sel.types.slice(), onlyUp: sel.onlyUp !== false } };
  return null;
}

// Canonical-stringify an autoMonitorInterfaces selection for change detection.
// Sorts string arrays so reordering inside a list doesn't read as a change,
// normalizes booleans, and collapses null / {} / coerced-legacy shapes to the
// same string ("null"). Used by the save handler to skip the per-class apply
// pass when nothing about that block's selection actually changed — saving
// for an unrelated reason (API token rotation, name change, monitoring tier
// edit) shouldn't re-fire an apply that can be expensive on big fleets.
function _amonCanonicalize(sel) {
  var coerced = _amonCoerceLegacy(sel);
  if (!coerced) return "null";
  var out = {};
  if (coerced.byNames && Array.isArray(coerced.byNames.names)) {
    out.byNames = { names: coerced.byNames.names.slice().sort() };
  }
  if (coerced.byPatterns && Array.isArray(coerced.byPatterns.patterns)) {
    out.byPatterns = {
      patterns: coerced.byPatterns.patterns.slice().sort(),
      regex:    coerced.byPatterns.regex === true,
      onlyUp:   coerced.byPatterns.onlyUp === true,
    };
  }
  if (coerced.byTypes && Array.isArray(coerced.byTypes.types)) {
    out.byTypes = {
      types:  coerced.byTypes.types.slice().sort(),
      onlyUp: coerced.byTypes.onlyUp === true,
      includeDownTunnels: coerced.byTypes.includeDownTunnels === true,
    };
  }
  if (coerced.byLldp && Array.isArray(coerced.byLldp.neighborTypes)) {
    out.byLldp = { neighborTypes: coerced.byLldp.neighborTypes.slice().sort() };
  }
  if (Object.keys(out).length === 0) return "null";
  return JSON.stringify(out);
}

// Renders one "By interface type" row. For the tunnel row it appends an
// inline "Include down tunnels" control (id `<prefix>types-includeDown`,
// wrapped in `<prefix>types-includeDown-wrap` for show/hide) to the right of
// the type label — visible only when tunnel is checked, since a down IPsec
// tunnel is something operators commonly want to monitor even with "Only
// currently up" on. The tunnel row also carries a sub-hint noting that
// "tunnel" covers FortiOS IPsec tunnels: when selected, those pins route to
// Asset.monitoredIpsecTunnels (the IPsec sampler's fast-poll list) rather than
// the IF-MIB monitoredInterfaces list — see splitPinsByProvenance in
// src/services/autoMonitorInterfacesService.ts. Shared by the initial saved
// render and the post-aggregate re-render so the two never diverge.
function _amonTypeRowHTML(idPrefix, name, checked, inclDownChecked, inclDownVisible) {
  var label = '<label style="display:flex;align-items:center;gap:6px;font-size:0.88rem;margin-bottom:0.25rem">' +
                '<input type="checkbox" data-type-checkbox="1" id="' + idPrefix + 'type-' + name + '" value="' + name + '"' + (checked ? " checked" : "") + ' style="width:auto"> ' + name +
              '</label>';
  if (name !== "tunnel") return label;
  var incl = '<span id="' + idPrefix + 'types-includeDown-wrap" style="display:' + (inclDownVisible ? "inline-flex" : "none") + ';align-items:center;margin-bottom:0.25rem">' +
               '<label style="display:flex;align-items:center;gap:6px;font-size:0.84rem;margin:0;cursor:pointer">' +
                 '<input type="checkbox" id="' + idPrefix + 'types-includeDown"' + (inclDownChecked ? " checked" : "") + ' style="width:auto"> Include down tunnels' +
                 ' <span class="hint" style="margin:0;font-size:0.78rem">(otherwise excluded by &quot;Only currently up&quot;)</span>' +
               '</label>' +
             '</span>';
  var ipsecHint = '<p class="hint" style="margin:0 0 0.35rem 1.6rem;font-size:0.78rem">' +
                    'Includes FortiOS IPsec tunnels — selecting this pins them for fast IPsec polling.' +
                  '</p>';
  return '<div style="display:flex;align-items:center;gap:14px">' + label + incl + '</div>' + ipsecHint;
}

function _autoMonitorInterfacesHTML(idPrefix, kindLabel, currentSelection, _defaultMode, hasIntegrationId, opts) {
  // opts.hideLldp — omit the "By LLDP" block. AD/Entra-monitored endpoints
  // report interfaces via the Polaris Agent and carry no LLDP neighbor data,
  // so the block would never match; hide it to avoid a misleading control.
  var hideLldp = !!(opts && opts.hideLldp);
  var sel = _amonCoerceLegacy(currentSelection) || {};
  var byNames    = sel.byNames    || null;
  var byPatterns = sel.byPatterns || null;
  var byTypes    = sel.byTypes    || null;
  var byLldp     = sel.byLldp     || null;

  // Stash the saved selection so the wire function can seed lastSentSelection
  // with it. The diff in the live preview compares each in-flight selection
  // against the PREVIOUS one sent — initial baseline = saved, so the first
  // render shows no diff and subsequent toggles show per-click adds/removes.
  // Stored under a per-card key so multiple cards in the same modal (the
  // FortiGate / FortiSwitch / FortiAP subtabs) don't clobber each other.
  window["__autoMon_savedSelection_" + idPrefix] = (Object.keys(sel).length > 0) ? sel : null;

  // Each "block" gets a master checkbox that controls visibility + inclusion.
  // Independent — operators can mix-and-match modes; the union is what gets
  // pinned. No "Disabled" toggle anymore: all four off = nothing pinned.
  function masterBox(value, label, hint, checked) {
    return '<label style="display:flex;align-items:center;gap:6px;margin-bottom:0.35rem;font-weight:500;cursor:pointer">' +
             '<input type="checkbox" data-amon-master="1" name="' + idPrefix + 'enable" value="' + value + '"' + (checked ? " checked" : "") + ' style="width:auto"> ' + escapeHtml(label) +
             (hint ? ' <span style="color:var(--color-text-tertiary);font-weight:400;font-size:0.82rem">— ' + escapeHtml(hint) + '</span>' : '') +
           '</label>';
  }

  // ─── By name panel ────────────────────────────────────────────────────────
  var namesPanel = '<div id="' + idPrefix + 'panel-names" style="display:' + (byNames ? '' : 'none') + ';margin:0.35rem 0 0.6rem 1.5rem">' +
    (hasIntegrationId
      ? '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.4rem;gap:8px">' +
          '<span class="hint" id="' + idPrefix + 'names-asof" style="margin:0;font-size:0.78rem"></span>' +
          '<span class="hint" id="' + idPrefix + 'names-counter" style="margin:0">Selected: 0</span>' +
        '</div>' +
        '<input type="text" id="' + idPrefix + 'names-filter" placeholder="Filter interface names…" autocomplete="off" style="width:100%;box-sizing:border-box;margin-bottom:0.4rem;padding:4px 8px;font-size:0.84rem">' +
        '<div id="' + idPrefix + 'names-list" style="display:flex;flex-direction:column;max-height:280px;overflow:auto;border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:0.5rem;background:var(--color-bg-tertiary)">' +
          '<p class="hint" style="margin:0">Loading…</p>' +
        '</div>' +
        '<p class="hint" style="margin:0.35rem 0 0 0;font-size:0.78rem">Aggregated from interfaces seen on this integration\'s ' + escapeHtml(_kindPlural(kindLabel)) + ', refreshed automatically at the end of each discovery run. Examples: <code>wan1</code>, <code>port1</code>, <code>FortiLink</code>.</p>'
      : '<p class="hint" style="margin:0;color:var(--color-warning)">Save the integration and run discovery first — interface names are aggregated from already-discovered devices.</p>'
    ) +
  '</div>';

  // ─── By pattern panel ─────────────────────────────────────────────────────
  var patternText = byPatterns ? byPatterns.patterns.join("\n") : "";
  var patternIsRegex = !!(byPatterns && byPatterns.regex === true);
  var patternOnlyUp  = !!(byPatterns && byPatterns.onlyUp === true);
  var patternsExample = patternIsRegex ? '^wan\\d+$&#10;^port(1|2)$' : 'wan*&#10;port4?';
  var patternsPanel = '<div id="' + idPrefix + 'panel-patterns" style="display:' + (byPatterns ? '' : 'none') + ';margin:0.35rem 0 0.6rem 1.5rem">' +
    '<div style="display:flex;align-items:center;gap:1.25rem;margin-bottom:0.4rem;font-size:0.86rem">' +
      '<label style="display:flex;align-items:center;gap:6px;margin:0;cursor:pointer">' +
        '<input type="radio" name="' + idPrefix + 'patterns-mode" value="wildcard"' + (patternIsRegex ? "" : " checked") + ' style="width:auto"> Wildcard' +
        ' <span class="hint" style="margin:0;font-size:0.78rem">(<code>*</code> any, <code>?</code> one)</span>' +
      '</label>' +
      '<label style="display:flex;align-items:center;gap:6px;margin:0;cursor:pointer">' +
        '<input type="radio" name="' + idPrefix + 'patterns-mode" value="regex"' + (patternIsRegex ? " checked" : "") + ' style="width:auto"> Regex' +
        ' <span class="hint" style="margin:0;font-size:0.78rem">(anchor with <code>^</code> / <code>$</code> if needed)</span>' +
      '</label>' +
    '</div>' +
    '<div class="form-group" style="margin-bottom:0.4rem">' +
      '<textarea id="' + idPrefix + 'patterns" rows="4" style="font-family:monospace;font-size:0.85rem;width:100%" placeholder="' + patternsExample + '">' + escapeHtml(patternText) + '</textarea>' +
    '</div>' +
    '<div style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap">' +
      '<label style="display:flex;align-items:center;gap:6px;font-size:0.86rem;margin:0">' +
        '<input type="checkbox" id="' + idPrefix + 'patterns-onlyUp"' + (patternOnlyUp ? " checked" : "") + ' style="width:auto"> Only currently up' +
        ' <span class="hint" style="margin:0;font-size:0.78rem">(skips disabled / disconnected ports)</span>' +
      '</label>' +
      '<button type="button" class="btn btn-secondary" id="' + idPrefix + 'patterns-test" style="font-size:0.78rem;padding:4px 12px"' +
        (hasIntegrationId ? '' : ' disabled title="Save the integration first"') + '>Test against fleet</button>' +
    '</div>' +
    '<div id="' + idPrefix + 'patterns-test-result" class="hint" style="margin:0.5rem 0 0 0;font-size:0.82rem;display:none;padding:0.45rem 0.6rem;background:var(--color-bg-tertiary);border-radius:var(--radius-sm);border:1px solid var(--color-border)"></div>' +
  '</div>';

  // ─── By interface type panel ──────────────────────────────────────────────
  // The list of types rendered here is sourced from the integration's
  // interface-aggregate endpoint at lazy-load time (shared with the By-name
  // load) so operators only see ifType values that actually exist on this
  // integration's discovered devices. Saved-selection types not present in
  // the latest discovery are preserved so a stored value isn't silently
  // dropped. The initial render shows only the saved-selection types (or a
  // loading placeholder when there's nothing saved yet) — the data load
  // replaces this with the observed set.
  var typeOnlyUp = byTypes ? byTypes.onlyUp !== false : true;
  var savedTypes = byTypes ? byTypes.types.slice() : [];
  var savedInclDown = !!(byTypes && byTypes.includeDownTunnels === true);
  // Stash for the loader so it can preserve saved-but-not-yet-rendered types
  // even before the user has opened this panel.
  window["__autoMon_typeSeed_" + idPrefix] = savedTypes;
  window["__autoMon_inclDownSeed_" + idPrefix] = savedInclDown;
  function _initialTypeBox(name) {
    // Initial render checks every saved type, so the tunnel row (if saved) is
    // checked → its include-down control is visible.
    return _amonTypeRowHTML(idPrefix, name, true, savedInclDown, true);
  }
  var initialTypesHtml = savedTypes.length > 0
    ? savedTypes.map(_initialTypeBox).join("")
    : (hasIntegrationId
        ? '<p class="hint" style="margin:0">Loading interface types…</p>'
        : '<p class="hint" style="margin:0;color:var(--color-warning)">Save the integration and run discovery first — interface types are aggregated from already-discovered devices.</p>');
  var typesPanel = '<div id="' + idPrefix + 'panel-types" style="display:' + (byTypes ? '' : 'none') + ';margin:0.35rem 0 0.6rem 1.5rem">' +
    '<div id="' + idPrefix + 'types-options">' + initialTypesHtml + '</div>' +
    '<label style="display:flex;align-items:center;gap:6px;font-size:0.86rem;margin-top:0.5rem">' +
      '<input type="checkbox" id="' + idPrefix + 'types-onlyUp"' + (typeOnlyUp ? " checked" : "") + ' style="width:auto"> Only currently up' +
      ' <span class="hint" style="margin:0;font-size:0.78rem">(skips disabled / disconnected ports)</span>' +
    '</label>' +
    '<p class="hint" style="margin:0.35rem 0 0 0;font-size:0.78rem">Only interface types observed on this integration\'s ' + escapeHtml(_kindPlural(kindLabel)) + ' are listed.</p>' +
  '</div>';

  // ─── By LLDP neighbor panel ───────────────────────────────────────────────
  var lldpSet = byLldp ? new Set(byLldp.neighborTypes) : new Set();
  function lldpBox(value, label) {
    var on = lldpSet.has(value) ? " checked" : "";
    return '<label style="display:flex;align-items:center;gap:6px;font-size:0.88rem;margin-bottom:0.25rem">' +
             '<input type="checkbox" data-lldp-checkbox="1" id="' + idPrefix + 'lldp-' + value + '" value="' + value + '"' + on + ' style="width:auto"> ' + escapeHtml(label) +
           '</label>';
  }
  var lldpPanel = '<div id="' + idPrefix + 'panel-lldp" style="display:' + (byLldp ? '' : 'none') + ';margin:0.35rem 0 0.6rem 1.5rem">' +
    '<p class="hint" style="margin:0 0 0.4rem 0;font-size:0.82rem">Pin where Polaris knows a <strong>monitored</strong> neighbor of the chosen type is connected — via direct LLDP advertisement <strong>OR</strong> via FortiOS topology inference (managed FortiAPs reported through their parent FortiGate, FortiSwitch FortiLink uplinks, etc.). Updates as fleet topology changes — new uplinks get pinned automatically next discovery.</p>' +
    lldpBox("firewall",     "Firewall") +
    lldpBox("switch",       "Switch") +
    lldpBox("access_point", "Access Point") +
    lldpBox("server",       "Server") +
    lldpBox("workstation",  "Workstation") +
    lldpBox("other",        "Other") +
  '</div>';

  // ─── Live preview (unioned across enabled blocks) ─────────────────────────
  var previewPanel = '<div id="' + idPrefix + 'preview" class="form-group" style="margin-top:0.8rem;padding:0.5rem 0.7rem;background:var(--color-bg-tertiary);border-radius:var(--radius-sm);border:1px solid var(--color-border);font-size:0.84rem;color:var(--color-text-secondary);min-height:1.4em">' +
    (hasIntegrationId ? '<em>Change a selection above to preview matches.</em>' : '<em>Preview becomes available after the integration is saved and discovery has run at least once.</em>') +
  '</div>';

  return sectionHeading("Auto-monitor interfaces") +
    '<div style="background:color-mix(in srgb, var(--color-accent) 6%, transparent);border:1px solid color-mix(in srgb, var(--color-accent) 20%, transparent);border-radius:var(--radius-md);padding:0.75rem 0.9rem;margin-bottom:1rem">' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);line-height:1.5;margin:0 0 0.2rem 0">Pin interfaces on every ' + escapeHtml(kindLabel) + ' discovered by this integration. Selected interfaces are added to each device\'s "Poll 1m" list and scraped on the response-time cadence (~60s). Operator-pinned interfaces on individual assets are preserved.</p>' +
      '<p class="hint" style="margin:0 0 0.6rem 0;font-size:0.78rem">Strictly additive — removing a selection here does <strong>not</strong> unpin interfaces already pinned on existing assets.</p>' +
      masterBox("names",    "By name",            "explicit ifNames from this integration's devices", !!byNames) +
      namesPanel +
      masterBox("patterns", "By pattern",         "wildcard or regex match",                          !!byPatterns) +
      patternsPanel +
      masterBox("types",    "By interface type",  "types seen on this integration's devices",         !!byTypes) +
      typesPanel +
      (hideLldp ? "" :
        masterBox("lldp",     "By LLDP (includes inferred interfaces)",   "pin where a monitored neighbor is connected (LLDP or FortiOS topology inference)",  !!byLldp) +
        lldpPanel) +
      previewPanel +
    '</div>' +
    formDivider();
}

// Reads the auto-monitor card into a server-shaped AutoMonitorSelection or
// null. Returns undefined when the card didn't render (subtab never opened).
// Client-side mirrors of the server's pattern compilers (autoMonitorInterfacesService
// compileWildcard / compilePattern), used by the instant cache-based preview so a
// "By pattern" selection can be matched against the cached ifName list without a
// server round-trip. Kept in lockstep with the server semantics: wildcard escapes
// regex metacharacters then maps * -> .* and ? -> . and anchors; regex mode is the
// raw (anchor-free) expression.
function _amonWildcardToRegex(pattern) {
  var escaped = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  escaped = escaped.replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
  try { return new RegExp("^" + escaped + "$"); } catch (e) { return null; }
}
function _amonRegexFromString(pattern) {
  try { return new RegExp(pattern); } catch (e) { return null; }
}

// Multi-block: each master checkbox gates its own block; the result is the
// union. An enabled block with no inner values populated (e.g. patterns
// master ticked but textarea empty) is dropped — server-side schema would
// reject it anyway.
function _readAutoMonitorInterfaces(idPrefix) {
  var masters = document.getElementsByName(idPrefix + "enable");
  if (!masters || masters.length === 0) return undefined;

  var enabled = { names: false, patterns: false, types: false, lldp: false };
  for (var m = 0; m < masters.length; m++) {
    if (masters[m].checked) enabled[masters[m].value] = true;
  }

  var out = {};

  if (enabled.names) {
    var checks = document.querySelectorAll('input[data-name-checkbox="1"][data-prefix="' + idPrefix + '"]:checked');
    var names = [];
    for (var j = 0; j < checks.length; j++) names.push(checks[j].value);
    if (names.length > 0) out.byNames = { names: names };
  }

  if (enabled.patterns) {
    var ta = document.getElementById(idPrefix + "patterns");
    var raw = ta ? String(ta.value || "") : "";
    var patterns = raw.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (patterns.length > 0) {
      var modeRadios = document.getElementsByName(idPrefix + "patterns-mode");
      var isRegex = false;
      for (var r = 0; r < modeRadios.length; r++) { if (modeRadios[r].checked && modeRadios[r].value === "regex") { isRegex = true; break; } }
      var ouEl = document.getElementById(idPrefix + "patterns-onlyUp");
      out.byPatterns = {
        patterns: patterns,
        regex:    isRegex,
        onlyUp:   ouEl ? ouEl.checked === true : false,
      };
    }
  }

  if (enabled.types) {
    var typeChecks = document.querySelectorAll('input[data-type-checkbox="1"][id^="' + idPrefix + 'type-"]:checked');
    var types = [];
    for (var k = 0; k < typeChecks.length; k++) {
      var v = typeChecks[k].value;
      if (v === "physical" || v === "aggregate" || v === "vlan" || v === "loopback" || v === "tunnel") types.push(v);
    }
    if (types.length > 0) {
      var ou2El = document.getElementById(idPrefix + "types-onlyUp");
      out.byTypes = { types: types, onlyUp: ou2El ? ou2El.checked === true : true };
      // Tunnel-only: pin fully-down IPsec tunnels too. Only meaningful when
      // "tunnel" is selected; omit the flag otherwise so it stays default-off.
      if (types.indexOf("tunnel") !== -1) {
        var inclEl = document.getElementById(idPrefix + "types-includeDown");
        if (inclEl && inclEl.checked === true) out.byTypes.includeDownTunnels = true;
      }
    }
  }

  if (enabled.lldp) {
    var lldpChecks = document.querySelectorAll('input[data-lldp-checkbox="1"][id^="' + idPrefix + 'lldp-"]:checked');
    var neighborTypes = [];
    var ALLOWED = { firewall:1, "switch":1, access_point:1, server:1, workstation:1, router:1, printer:1, other:1 };
    for (var l = 0; l < lldpChecks.length; l++) {
      var t = lldpChecks[l].value;
      if (ALLOWED[t]) neighborTypes.push(t);
    }
    if (neighborTypes.length > 0) out.byLldp = { neighborTypes: neighborTypes };
  }

  // If nothing usable was captured, persist null (= feature off for this class).
  if (!out.byNames && !out.byPatterns && !out.byTypes && !out.byLldp) return null;
  return out;
}

// ─── Auto-Monitor Storage card (AD / Entra workstation+server) ─────────────
// Storage-mount analog of _autoMonitorInterfacesHTML. Three independent blocks
// (By mount name / By pattern / All mounts); the union is pinned into
// Asset.monitoredStorage at discovery time. Mounts come from the Polaris Agent,
// so the "By name" checklist populates only after agents report.
function _autoMonitorStorageHTML(idPrefix, kindLabel, currentSelection, hasIntegrationId) {
  var sel = currentSelection && typeof currentSelection === "object" ? currentSelection : {};
  var byNames    = sel.byNames    || null;
  var byPatterns = sel.byPatterns || null;
  var all        = !!(sel.all && sel.all.all === true);
  window["__autoMonStor_savedSelection_" + idPrefix] = (byNames || byPatterns || all) ? sel : null;

  function masterBox(value, label, hint, checked) {
    return '<label style="display:flex;align-items:center;gap:6px;margin-bottom:0.35rem;font-weight:500;cursor:pointer">' +
             '<input type="checkbox" data-stor-master="1" name="' + idPrefix + 'enable" value="' + value + '"' + (checked ? " checked" : "") + ' style="width:auto"> ' + escapeHtml(label) +
             (hint ? ' <span style="color:var(--color-text-tertiary);font-weight:400;font-size:0.82rem">— ' + escapeHtml(hint) + '</span>' : '') +
           '</label>';
  }

  var namesPanel = '<div id="' + idPrefix + 'panel-names" style="display:' + (byNames ? '' : 'none') + ';margin:0.35rem 0 0.6rem 1.5rem">' +
    (hasIntegrationId
      ? '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.4rem;gap:8px">' +
          '<span class="hint" id="' + idPrefix + 'names-asof" style="margin:0;font-size:0.78rem"></span>' +
          '<span class="hint" id="' + idPrefix + 'names-counter" style="margin:0">Selected: 0</span>' +
        '</div>' +
        '<div id="' + idPrefix + 'names-list" style="display:flex;flex-direction:column;max-height:240px;overflow:auto;border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:0.5rem;background:var(--color-bg-tertiary)">' +
          '<p class="hint" style="margin:0">Loading…</p>' +
        '</div>' +
        '<p class="hint" style="margin:0.35rem 0 0 0;font-size:0.78rem">Aggregated from mounts reported by agents on this integration\'s ' + escapeHtml(_kindPlural(kindLabel)) + ', refreshed automatically at the end of each discovery run. Examples: <code>/</code>, <code>/var</code>, <code>C:</code>.</p>'
      : '<p class="hint" style="margin:0;color:var(--color-warning)">Save the integration and let agents report first — mounts are aggregated from already-discovered devices.</p>'
    ) +
  '</div>';

  var patternText = byPatterns ? byPatterns.patterns.join("\n") : "";
  var patternIsRegex = !!(byPatterns && byPatterns.regex === true);
  var patternsExample = patternIsRegex ? '^/var(/.*)?$&#10;^C:$' : '/var*&#10;C:';
  var patternsPanel = '<div id="' + idPrefix + 'panel-patterns" style="display:' + (byPatterns ? '' : 'none') + ';margin:0.35rem 0 0.6rem 1.5rem">' +
    '<div style="display:flex;align-items:center;gap:1.25rem;margin-bottom:0.4rem;font-size:0.86rem">' +
      '<label style="display:flex;align-items:center;gap:6px;margin:0;cursor:pointer">' +
        '<input type="radio" name="' + idPrefix + 'patterns-mode" value="wildcard"' + (patternIsRegex ? "" : " checked") + ' style="width:auto"> Wildcard' +
        ' <span class="hint" style="margin:0;font-size:0.78rem">(<code>*</code> any, <code>?</code> one)</span>' +
      '</label>' +
      '<label style="display:flex;align-items:center;gap:6px;margin:0;cursor:pointer">' +
        '<input type="radio" name="' + idPrefix + 'patterns-mode" value="regex"' + (patternIsRegex ? " checked" : "") + ' style="width:auto"> Regex' +
      '</label>' +
    '</div>' +
    '<div class="form-group" style="margin-bottom:0.4rem">' +
      '<textarea id="' + idPrefix + 'patterns" rows="3" style="font-family:monospace;font-size:0.85rem;width:100%" placeholder="' + patternsExample + '">' + escapeHtml(patternText) + '</textarea>' +
    '</div>' +
  '</div>';

  var allPanel = '<div id="' + idPrefix + 'panel-all" style="display:' + (all ? '' : 'none') + ';margin:0.1rem 0 0.6rem 1.5rem">' +
    '<p class="hint" style="margin:0;font-size:0.8rem">Every mount observed on each device gets pinned. Strictly additive across cycles.</p>' +
  '</div>';

  var previewPanel = '<div id="' + idPrefix + 'preview" class="form-group" style="margin-top:0.8rem;padding:0.5rem 0.7rem;background:var(--color-bg-tertiary);border-radius:var(--radius-sm);border:1px solid var(--color-border);font-size:0.84rem;color:var(--color-text-secondary);min-height:1.4em">' +
    (hasIntegrationId ? '<em>Enable a block to preview matches.</em>' : '<em>Preview becomes available after the integration is saved and agents report.</em>') +
  '</div>';

  return sectionHeading("Auto-monitor storage") +
    '<div style="background:color-mix(in srgb, var(--color-accent) 6%, transparent);border:1px solid color-mix(in srgb, var(--color-accent) 20%, transparent);border-radius:var(--radius-md);padding:0.75rem 0.9rem;margin-bottom:1rem">' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);line-height:1.5;margin:0 0 0.2rem 0">Pin storage mounts on every ' + escapeHtml(kindLabel) + ' discovered by this integration. Selected mounts are re-walked on the fast cadence. Operator-pinned mounts on individual assets are preserved.</p>' +
      '<p class="hint" style="margin:0 0 0.6rem 0;font-size:0.78rem">Strictly additive — removing a selection here does <strong>not</strong> unpin mounts already pinned on existing assets.</p>' +
      masterBox("names",    "By mount name", "explicit mounts reported by agents",   !!byNames) +
      namesPanel +
      masterBox("patterns", "By pattern",    "wildcard or regex match on mount path", !!byPatterns) +
      patternsPanel +
      masterBox("all",      "All mounts",    "pin every observed mount",              all) +
      allPanel +
      previewPanel +
    '</div>' +
    formDivider();
}

// Reads the storage card into an AutoMonitorStorageSelection or null. Returns
// undefined when the card didn't render (subtab never opened).
function _readAutoMonitorStorage(idPrefix) {
  var masters = document.getElementsByName(idPrefix + "enable");
  if (!masters || masters.length === 0) return undefined;
  var enabled = { names: false, patterns: false, all: false };
  for (var m = 0; m < masters.length; m++) { if (masters[m].checked) enabled[masters[m].value] = true; }
  var out = {};
  if (enabled.names) {
    var checks = document.querySelectorAll('input[data-stor-name-checkbox="1"][data-prefix="' + idPrefix + '"]:checked');
    var names = [];
    for (var j = 0; j < checks.length; j++) names.push(checks[j].value);
    if (names.length > 0) out.byNames = { names: names };
  }
  if (enabled.patterns) {
    var ta = document.getElementById(idPrefix + "patterns");
    var raw = ta ? String(ta.value || "") : "";
    var patterns = raw.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (patterns.length > 0) {
      var modeRadios = document.getElementsByName(idPrefix + "patterns-mode");
      var isRegex = false;
      for (var r = 0; r < modeRadios.length; r++) { if (modeRadios[r].checked && modeRadios[r].value === "regex") { isRegex = true; break; } }
      out.byPatterns = { patterns: patterns, regex: isRegex };
    }
  }
  if (enabled.all) out.all = { all: true };
  if (!out.byNames && !out.byPatterns && !out.all) return null;
  return out;
}

// ─── Agent Auto-Deploy card (AD / Entra workstation+server) ────────────────
// Toggle + SSH/WinRM credential pickers + max-concurrent. Default OFF, with a
// prominent warning: enabling pushes the Polaris Agent to every newly-
// discovered, agent-less device of this class during discovery.
function _agentDeployHTML(idPrefix, kindLabel, currentCfg, credentials) {
  var cfg = currentCfg && typeof currentCfg === "object" ? currentCfg : null;
  var enabled = !!(cfg && cfg.enabled === true);
  var maxConc = (cfg && Number.isFinite(cfg.maxConcurrent)) ? cfg.maxConcurrent : 4;
  function credSelect(type, label, selectId, selectedId) {
    var rows = (credentials || []).filter(function (c) { return c.type === type; });
    var options = '<option value="">— none —</option>' +
      rows.map(function (c) {
        var s = (selectedId && c.id === selectedId) ? " selected" : "";
        return '<option value="' + escapeHtml(c.id) + '"' + s + '>' + escapeHtml(c.name) + '</option>';
      }).join("");
    var emptyHint = rows.length === 0
      ? '<p class="hint" style="color:var(--color-warning);margin:0.2rem 0 0 0">No ' + escapeHtml(label) + ' credentials defined — add one under Server Settings &gt; Credentials.</p>' : '';
    return '<div class="form-group" style="margin-bottom:0.6rem">' +
        '<label>' + escapeHtml(label) + ' credential</label>' +
        '<select id="' + selectId + '">' + options + '</select>' + emptyHint +
      '</div>';
  }
  var bodyHidden = enabled ? "" : "display:none";
  // Turning this ON is gated `assets=fullwrite` server-side (the same grant as
  // deploying to ONE device — see assertAgentDeployGrant in
  // api/routes/integrations.ts), chained onto integrations=write. A caller
  // without it sees the card's current state read-only rather than a toggle
  // whose save 403s; an ALREADY-enabled block stays switchable OFF, which is
  // the one direction that needs no extra grant.
  var mayDeploy = (typeof canDeployAgent !== "function") || canDeployAgent();
  var lockToggle = (!mayDeploy && !enabled) ? " disabled" : "";
  var lockNote = (!mayDeploy && !enabled)
    ? '<p class="hint" style="margin:0 0 0.5rem 0">Enabling auto-deploy needs Full Read-Write on Assets — the same grant as installing the agent on a single device.</p>'
    : '';
  return sectionHeading("Agent auto-deploy") +
    '<div style="background:color-mix(in srgb, var(--color-warning) 6%, transparent);border:1px solid color-mix(in srgb, var(--color-warning) 30%, transparent);border-radius:var(--radius-md);padding:0.75rem 0.9rem;margin-bottom:1rem">' +
      '<div class="form-group" style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<input type="checkbox" id="' + idPrefix + 'enabled" ' + (enabled ? "checked" : "") + lockToggle + ' style="width:auto">' +
        '<label for="' + idPrefix + 'enabled" style="margin:0;font-weight:500">Auto-deploy the Polaris Agent to discovered ' + escapeHtml(_kindPlural(kindLabel)) + '</label>' +
      '</div>' +
      lockNote +
      '<p class="hint" style="margin:0 0 0.5rem 0;color:var(--color-warning)">⚠ Pushes the Polaris Agent over SSH/WinRM to every newly-discovered, agent-less ' + escapeHtml(kindLabel) + ' during discovery. Test on a small OU first; a human should review rollout scope before enabling fleet-wide. Rollout is paced — at most a few new installs per discovery cycle.</p>' +
      '<div id="' + idPrefix + 'body" style="' + bodyHidden + '">' +
        '<p class="hint" style="margin:0 0 0.5rem 0;font-size:0.8rem">Platform is inferred from each device\'s OS. Windows uses WinRM (or SSH if no WinRM credential); Linux/macOS use SSH.</p>' +
        credSelect("ssh",   "SSH",   idPrefix + "sshCredentialId",   cfg ? cfg.sshCredentialId   : null) +
        credSelect("winrm", "WinRM", idPrefix + "winrmCredentialId", cfg ? cfg.winrmCredentialId : null) +
        '<div class="form-group" style="margin-bottom:0">' +
          '<label>Max concurrent installs per cycle</label>' +
          '<input type="number" id="' + idPrefix + 'maxConcurrent" min="1" max="20" value="' + maxConc + '" style="width:90px">' +
        '</div>' +
      '</div>' +
    '</div>';
}

// Reads the agent-deploy card into an agentDeploy block or null. Returns
// undefined when the card didn't render. When the toggle is off but a config
// existed, we still return {enabled:false,...} so the operator's stored
// credential picks survive a save with the feature toggled off.
function _readAgentDeploy(idPrefix) {
  var toggle = document.getElementById(idPrefix + "enabled");
  if (!toggle) return undefined;
  var ssh = document.getElementById(idPrefix + "sshCredentialId");
  var winrm = document.getElementById(idPrefix + "winrmCredentialId");
  var maxEl = document.getElementById(idPrefix + "maxConcurrent");
  var maxConcurrent = maxEl ? parseInt(maxEl.value, 10) : 4;
  if (!Number.isFinite(maxConcurrent) || maxConcurrent < 1) maxConcurrent = 4;
  if (maxConcurrent > 20) maxConcurrent = 20;
  return {
    enabled:           toggle.checked === true,
    sshCredentialId:   (ssh && ssh.value)   ? ssh.value   : null,
    winrmCredentialId: (winrm && winrm.value) ? winrm.value : null,
    maxConcurrent:     maxConcurrent,
  };
}

// Wires the storage card: master-toggle panel visibility, lazy aggregate load
// for the "By name" checklist, and a debounced live preview. Mirrors the
// interface card's wiring but with the storage endpoints + selection shape.
function _wireAutoMonitorStorageCard(idPrefix, klass, integrationId) {
  var masters = document.getElementsByName(idPrefix + "enable");
  if (!masters || masters.length === 0) return;
  var panels = {
    names:    document.getElementById(idPrefix + "panel-names"),
    patterns: document.getElementById(idPrefix + "panel-patterns"),
    all:      document.getElementById(idPrefix + "panel-all"),
  };
  var preview = document.getElementById(idPrefix + "preview");
  var aggregateLoaded = false;

  function updateCounter() {
    var counter = document.getElementById(idPrefix + "names-counter");
    if (!counter) return;
    var total = document.querySelectorAll('input[data-stor-name-checkbox="1"][data-prefix="' + idPrefix + '"]').length;
    var picked = document.querySelectorAll('input[data-stor-name-checkbox="1"][data-prefix="' + idPrefix + '"]:checked').length;
    counter.textContent = "Selected: " + picked + " / " + total;
  }

  function renderNamesList(rows) {
    var listEl = document.getElementById(idPrefix + "names-list");
    if (!listEl) return;
    var existingChecked = new Set();
    var existing = document.querySelectorAll('input[data-stor-name-checkbox="1"][data-prefix="' + idPrefix + '"]:checked');
    for (var i = 0; i < existing.length; i++) existingChecked.add(existing[i].value);
    var seed = window["__autoMonStor_seed_" + idPrefix];
    if (seed && seed.length) seed.forEach(function (n) { existingChecked.add(n); });
    if (rows.length === 0) {
      listEl.innerHTML = '<p class="hint" style="margin:0;color:var(--color-warning)">No mount samples yet. Once agents report storage on each discovered device, mounts appear here.</p>';
    } else {
      listEl.innerHTML = rows.map(function (r) {
        var checked = existingChecked.has(r.mountPath) ? " checked" : "";
        return '<label style="display:flex;align-items:center;gap:6px;padding:2px 0;font-size:0.86rem">' +
                 '<input type="checkbox" data-stor-name-checkbox="1" data-prefix="' + idPrefix + '" value="' + escapeHtml(r.mountPath) + '"' + checked + ' style="width:auto">' +
                 '<span style="font-family:monospace">' + escapeHtml(r.mountPath) + '</span>' +
                 '<span class="hint" style="margin:0 0 0 auto;font-size:0.78rem">' + r.deviceCount + ' device' + (r.deviceCount === 1 ? "" : "s") + '</span>' +
               '</label>';
      }).join("");
    }
    var boxes = listEl.querySelectorAll('input[data-stor-name-checkbox="1"]');
    for (var b = 0; b < boxes.length; b++) boxes[b].addEventListener("change", function () { updateCounter(); schedulePreview(); });
    updateCounter();
    schedulePreview();
  }

  function loadAggregate(force) {
    if (!integrationId) return;
    if (!force && aggregateLoaded) return;
    var listEl = document.getElementById(idPrefix + "names-list");
    if (listEl) listEl.innerHTML = '<p class="hint" style="margin:0">Loading…</p>';
    api.integrations.storageAggregate(integrationId, klass).then(function (resp) {
      aggregateLoaded = true;
      var asof = document.getElementById(idPrefix + "names-asof");
      if (asof) asof.textContent = (resp && resp.computedAt) ? ("As of last discovery: " + formatDateTime(resp.computedAt)) : "";
      renderNamesList((resp && resp.rows) || []);
    }).catch(function (err) {
      if (listEl) listEl.innerHTML = '<p class="hint" style="margin:0;color:var(--color-danger)">Failed to load: ' + escapeHtml(err.message || "unknown error") + '</p>';
    });
  }

  function syncMasterVisibility() {
    for (var m = 0; m < masters.length; m++) {
      var checked = masters[m].checked;
      var key = masters[m].value;
      if (panels[key]) panels[key].style.display = checked ? "" : "none";
      if (key === "names" && checked && !aggregateLoaded && integrationId) loadAggregate();
    }
  }

  var previewTimer = null;
  function schedulePreview() {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(runPreview, 250);
  }
  function runPreview() {
    if (!preview) return;
    if (!integrationId) { preview.innerHTML = '<em>Preview becomes available after the integration is saved and agents report.</em>'; return; }
    var selection = _readAutoMonitorStorage(idPrefix);
    if (!selection) { preview.innerHTML = '<em>Enable a block and add at least one value to preview matches.</em>'; return; }
    // Placeholder while the live resolve runs — on a large fleet it can take a
    // moment, and a blank box reads as broken.
    preview.innerHTML = '<em>Computing matches…</em>';
    api.integrations.storageAggregatePreview(integrationId, { class: klass, selection: selection }).then(function (r) {
      if (!r || r.deviceCount === 0) { preview.innerHTML = '<em>No mounts match yet.</em>'; return; }
      var sample = (r.sampleDevices || []).map(function (d) { return escapeHtml(d.hostname || "(unnamed)") + " (" + d.pinNames.length + ")"; }).join(", ");
      preview.innerHTML = '<strong>' + r.mountCount + '</strong> mount(s) across <strong>' + r.deviceCount + '</strong> device(s)' + (sample ? ' — e.g. ' + sample : '');
    }).catch(function (err) {
      preview.innerHTML = '<span style="color:var(--color-danger)">Preview failed: ' + escapeHtml(err.message || "unknown error") + '</span>';
    });
  }

  for (var m = 0; m < masters.length; m++) masters[m].addEventListener("change", function () { syncMasterVisibility(); schedulePreview(); });
  var ta = document.getElementById(idPrefix + "patterns");
  if (ta) ta.addEventListener("input", schedulePreview);
  var modeRadios = document.getElementsByName(idPrefix + "patterns-mode");
  for (var mr = 0; mr < modeRadios.length; mr++) modeRadios[mr].addEventListener("change", schedulePreview);
  syncMasterVisibility();
  // Wire the agent-deploy toggle to reveal its body. The deploy card shares the
  // ws/server subtab; its prefix swaps -stor- → -deploy-.
  var deployPrefix = idPrefix.replace(/-stor-$/, "-deploy-");
  var deployToggle = document.getElementById(deployPrefix + "enabled");
  var deployBody = document.getElementById(deployPrefix + "body");
  if (deployToggle && deployBody) {
    deployToggle.addEventListener("change", function () { deployBody.style.display = deployToggle.checked ? "" : "none"; });
  }
}

// Wires change-listeners on a freshly-rendered auto-monitor card. Toggles
// panel visibility + fetches the aggregate list lazily on first "By name"
// expand + debounces a preview call into the preview block. Safe to call
// after the card's HTML has been inserted into the DOM.
function _wireAutoMonitorCard(idPrefix, klass, integrationId) {
  var masters = document.getElementsByName(idPrefix + "enable");
  if (!masters || masters.length === 0) return;
  var panels = {
    names:    document.getElementById(idPrefix + "panel-names"),
    patterns: document.getElementById(idPrefix + "panel-patterns"),
    types:    document.getElementById(idPrefix + "panel-types"),
    lldp:     document.getElementById(idPrefix + "panel-lldp"),
  };
  var preview = document.getElementById(idPrefix + "preview");
  var aggregateLoaded = false;
  var aggregateRows = null;
  // Per-card tracking of the most recently sent selection. The next preview
  // request passes this as `baselineSelection`, so the backend's diff block
  // shows the delta from the operator's previous click — not from the saved
  // state. Initial baseline = saved selection at modal open (stashed by
  // _autoMonitorInterfacesHTML), so the first preview-on-open shows no diff.
  var lastSentSelection = window["__autoMon_savedSelection_" + idPrefix] || null;
  // The live preview box (interface/device counts, "Change since last edit"
  // diff, "First matches") stays quiet until the operator actually changes a
  // selection. Automatic renders (initial wire, aggregate load, reload) call
  // schedulePreview but no-op while this is false, so opening the modal on a
  // saved selection doesn't flash a full preview the operator didn't ask for.
  var userHasEdited = false;
  // Canonical IfType order — matches IF_TYPES in src/services/autoMonitorInterfacesService.ts.
  // Backend Zod schema rejects values outside this set, so the UI mirrors it.
  var CANONICAL_IF_TYPES = ["physical", "aggregate", "vlan", "loopback", "tunnel"];
  // Tracks the "Include down tunnels" checkbox across type-list re-renders
  // (renderTypesList rebuilds innerHTML, destroying the DOM element). Seeded
  // from the saved selection; updated by the include-down change handler.
  var inclDownState = window["__autoMon_inclDownSeed_" + idPrefix] === true;

  function syncMasterVisibility() {
    var anyEnabled = false;
    for (var m = 0; m < masters.length; m++) {
      var checked = masters[m].checked;
      var key = masters[m].value;
      if (panels[key]) panels[key].style.display = checked ? "" : "none";
      if (checked) anyEnabled = true;
      if ((key === "names" || key === "types") && checked && !aggregateLoaded && integrationId) loadAggregate();
    }
    return anyEnabled;
  }

  // (Re)binds the tunnel row's "Include down tunnels" control: tunnel checkbox
  // toggles its visibility; the include-down checkbox updates inclDownState +
  // re-previews. Called after every type-list render (initial + dynamic) since
  // the elements are recreated each time.
  function wireInclDown() {
    var tunnelBox = document.getElementById(idPrefix + "type-tunnel");
    var wrap = document.getElementById(idPrefix + "types-includeDown-wrap");
    var inclBox = document.getElementById(idPrefix + "types-includeDown");
    if (tunnelBox && wrap) {
      tunnelBox.addEventListener("change", function () {
        wrap.style.display = tunnelBox.checked ? "inline-flex" : "none";
      });
    }
    if (inclBox) {
      inclBox.addEventListener("change", function () {
        inclDownState = inclBox.checked === true;
        onUserChange();
      });
    }
  }

  // Renders the dynamic "By interface type" checklist from cached aggregate
  // rows. Only canonical ifTypes that actually appear in the integration's
  // discovered samples are listed, plus any saved-selection types not seen
  // in the latest data (preserved so a stored value isn't silently dropped).
  // Already-checked boxes in the DOM are preserved across re-renders.
  function renderTypesList() {
    var optsEl = document.getElementById(idPrefix + "types-options");
    if (!optsEl || aggregateRows === null) return;
    var existingChecked = new Set();
    var existing = optsEl.querySelectorAll('input[data-type-checkbox="1"]:checked');
    for (var i = 0; i < existing.length; i++) existingChecked.add(existing[i].value);
    var seed = window["__autoMon_typeSeed_" + idPrefix];
    if (seed && seed.length) seed.forEach(function (t) { existingChecked.add(t); });
    var seenTypes = new Set();
    for (var r = 0; r < aggregateRows.length; r++) {
      var t = aggregateRows[r].ifType;
      if (t && CANONICAL_IF_TYPES.indexOf(t) !== -1) seenTypes.add(t);
    }
    // Union the observed types with any saved-selection types we need to
    // preserve. Render in canonical order.
    var renderSet = new Set(seenTypes);
    existingChecked.forEach(function (t) {
      if (CANONICAL_IF_TYPES.indexOf(t) !== -1) renderSet.add(t);
    });
    var rendered = CANONICAL_IF_TYPES.filter(function (t) { return renderSet.has(t); });
    if (rendered.length === 0) {
      optsEl.innerHTML = '<p class="hint" style="margin:0;color:var(--color-warning)">No interface types found yet. Once monitoring runs at least one System Info pass on each discovered device, types will appear here.</p>';
      return;
    }
    optsEl.innerHTML = rendered.map(function (name) {
      var on = existingChecked.has(name);
      // Tunnel row's include-down control: checked from the tracked closure
      // state (survives re-renders), visible only when tunnel itself is checked.
      return _amonTypeRowHTML(idPrefix, name, on, inclDownState, on);
    }).join("");
    var boxes = optsEl.querySelectorAll('input[data-type-checkbox="1"]');
    for (var b = 0; b < boxes.length; b++) {
      boxes[b].addEventListener("change", onUserChange);
    }
    wireInclDown();
  }

  function loadAggregate(force) {
    if (!integrationId) return;
    if (!force && aggregateLoaded) return;
    var listEl = document.getElementById(idPrefix + "names-list");
    var typesEl = document.getElementById(idPrefix + "types-options");
    if (listEl) listEl.innerHTML = '<p class="hint" style="margin:0">Loading…</p>';
    if (typesEl && (force || !aggregateRows)) typesEl.innerHTML = '<p class="hint" style="margin:0">Loading interface types…</p>';
    api.integrations.interfaceAggregate(integrationId, klass).then(function (resp) {
      aggregateLoaded = true;
      var rows = (resp && resp.rows) || [];
      aggregateRows = rows;
      var asof = document.getElementById(idPrefix + "names-asof");
      if (asof) asof.textContent = (resp && resp.computedAt) ? ("As of last discovery: " + formatDateTime(resp.computedAt)) : "";
      renderNamesList(rows);
      renderTypesList();
    }).catch(function (err) {
      if (listEl) listEl.innerHTML = '<p class="hint" style="margin:0;color:var(--color-danger)">Failed to load: ' + escapeHtml(err.message || "unknown error") + '</p>';
      if (typesEl) typesEl.innerHTML = '<p class="hint" style="margin:0;color:var(--color-danger)">Failed to load: ' + escapeHtml(err.message || "unknown error") + '</p>';
    });
  }

  function renderNamesList(rows) {
    var listEl = document.getElementById(idPrefix + "names-list");
    if (!listEl) return;
    // Preserve any names the operator already checked from a prior selection.
    var existingChecked = new Set();
    var existing = document.querySelectorAll('input[data-name-checkbox="1"][data-prefix="' + idPrefix + '"]:checked');
    for (var i = 0; i < existing.length; i++) existingChecked.add(existing[i].value);
    // ALSO seed with the original currentSelection.names so "By name" remembers
    // the saved selection even when it doesn't match anything in the latest aggregate.
    if (window["__autoMon_seed_" + idPrefix]) {
      window["__autoMon_seed_" + idPrefix].forEach(function (n) { existingChecked.add(n); });
    }
    if (rows.length === 0) {
      listEl.innerHTML = '<p class="hint" style="margin:0;color:var(--color-warning)">No interface samples yet. Once monitoring runs at least one System Info pass on each discovered device, names will appear here.</p>';
    } else {
      listEl.innerHTML = rows.map(function (r) {
        var checked = existingChecked.has(r.ifName) ? " checked" : "";
        var typeTag = r.ifType ? '<span class="hint" style="margin:0 0 0 6px;font-size:0.78rem">[' + escapeHtml(r.ifType) + ']</span>' : "";
        return '<label style="display:flex;align-items:center;gap:6px;padding:2px 0;font-size:0.86rem">' +
                 '<input type="checkbox" data-name-checkbox="1" data-prefix="' + idPrefix + '" value="' + escapeHtml(r.ifName) + '"' + checked + ' style="width:auto">' +
                 '<span style="font-family:monospace">' + escapeHtml(r.ifName) + '</span>' +
                 typeTag +
                 '<span class="hint" style="margin:0 0 0 auto;font-size:0.78rem">' + r.deviceCount + ' device' + (r.deviceCount === 1 ? "" : "s") + '</span>' +
               '</label>';
      }).join("");
    }
    // Hand-roll the change listener — fires the preview + selected counter.
    var boxes = listEl.querySelectorAll('input[data-name-checkbox="1"]');
    for (var b = 0; b < boxes.length; b++) {
      boxes[b].addEventListener("change", function () { updateNamesCounter(); onUserChange(); });
    }
    updateNamesCounter();
    applyNamesFilter();
    schedulePreview();
  }

  function updateNamesCounter() {
    var counter = document.getElementById(idPrefix + "names-counter");
    if (!counter) return;
    var total = document.querySelectorAll('input[data-name-checkbox="1"][data-prefix="' + idPrefix + '"]').length;
    var picked = document.querySelectorAll('input[data-name-checkbox="1"][data-prefix="' + idPrefix + '"]:checked').length;
    counter.textContent = "Selected: " + picked + " / " + total;
  }

  // View-only filter over the "By name" checklist. Substring-matches the
  // ifName (case-insensitive) and hides non-matching rows; never touches the
  // checkboxes themselves, so a row hidden by the filter keeps its selection.
  // Re-applied after every renderNamesList so a reload preserves the filter.
  function applyNamesFilter() {
    var input = document.getElementById(idPrefix + "names-filter");
    var listEl = document.getElementById(idPrefix + "names-list");
    if (!input || !listEl) return;
    var q = String(input.value || "").trim().toLowerCase();
    var rows = listEl.querySelectorAll('label');
    for (var i = 0; i < rows.length; i++) {
      var cb = rows[i].querySelector('input[data-name-checkbox="1"]');
      if (!cb) continue;
      var match = !q || String(cb.value || "").toLowerCase().indexOf(q) !== -1;
      rows[i].style.display = match ? "" : "none";
    }
  }

  // Debounced preview fetch.
  var previewTimer = null;
  function schedulePreview() {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(runPreview, 250);
  }
  // Marks an operator-driven change and schedules the preview. Wired to every
  // selection control so the preview box populates on real edits, while the
  // automatic schedulePreview() calls (initial wire / aggregate load) stay no-ops.
  function onUserChange() {
    userHasEdited = true;
    schedulePreview();
  }

  // Map of ifName -> deviceCount from the last cache-based preview, for the
  // instant per-edit diff (no server round-trip).
  var lastClientMatched = null;

  // Instant preview computed from the cached aggregate (aggregateRows) — no
  // server round-trip. Exact for By name (names always pin regardless of link
  // state). For By pattern / By type it can't honor onlyUp (the cache holds no
  // per-device operStatus), so the count is an upper bound, flagged `approx`.
  // Returns null when the selection needs live data the cache doesn't hold
  // (By LLDP → topology) so the caller falls back to the live server preview.
  function computeClientPreview(selection) {
    if (!selection || selection.byLldp) return null;
    if (!aggregateLoaded) return null; // rows not loaded yet — caller loads + retries
    var byName = {};
    for (var i = 0; i < aggregateRows.length; i++) byName[aggregateRows[i].ifName] = aggregateRows[i];
    var matched = {}; // ifName -> deviceCount (union across blocks; each name once)
    if (selection.byNames) {
      selection.byNames.names.forEach(function (n) {
        matched[n] = byName[n] ? (byName[n].deviceCount || 0) : 0;
      });
    }
    if (selection.byPatterns) {
      var res = selection.byPatterns.patterns.map(function (p) {
        return selection.byPatterns.regex ? _amonRegexFromString(p) : _amonWildcardToRegex(p);
      }).filter(Boolean);
      aggregateRows.forEach(function (row) {
        if (res.some(function (re) { return re.test(row.ifName); })) matched[row.ifName] = row.deviceCount || 0;
      });
    }
    if (selection.byTypes) {
      var typeSet = {};
      selection.byTypes.types.forEach(function (t) { typeSet[t] = 1; });
      aggregateRows.forEach(function (row) {
        if (row.ifType && typeSet[row.ifType]) matched[row.ifName] = row.deviceCount || 0;
      });
    }
    var approx = (selection.byPatterns && selection.byPatterns.onlyUp === true) ||
                 (selection.byTypes && selection.byTypes.onlyUp !== false);
    return { matched: matched, approx: !!approx };
  }

  // Render the instant cache-based preview + an ifName-level diff vs the last
  // client preview. Pin count for a name = its fleet deviceCount.
  function renderClientPreview(client) {
    var matched = client.matched;
    var names = Object.keys(matched);
    var interfaceCount = 0;
    names.forEach(function (n) { interfaceCount += matched[n] || 0; });
    var warn = interfaceCount > AUTO_MONITOR_INTERFACE_WARN_THRESHOLD;

    var diffHtml = "";
    if (lastClientMatched) {
      var addedPins = 0, removedPins = 0, addedNames = [], removedNames = [];
      names.forEach(function (n) {
        if (!(n in lastClientMatched)) { addedPins += matched[n] || 0; if (addedNames.length < 3) addedNames.push(n); }
      });
      Object.keys(lastClientMatched).forEach(function (n) {
        if (!(n in matched)) { removedPins += lastClientMatched[n] || 0; if (removedNames.length < 3) removedNames.push(n); }
      });
      if (addedPins > 0 || removedPins > 0) {
        var parts = [];
        if (addedPins > 0) parts.push('<span style="color:var(--color-success);font-weight:600">+' + addedPins + ' added</span>');
        if (removedPins > 0) parts.push('<span style="color:var(--color-warning);font-weight:600">−' + removedPins + ' removed</span>');
        var sampleParts = addedNames.map(function (n) { return '<span style="color:var(--color-success)">+' + escapeHtml(n) + '</span>'; })
          .concat(removedNames.map(function (n) { return '<span style="color:var(--color-warning)">−' + escapeHtml(n) + '</span>'; }));
        diffHtml = '<div style="margin-top:0.3rem;font-size:0.82rem">Change since last edit: ' + parts.join(" · ") +
          (sampleParts.length ? ' <span class="hint" style="margin:0 0 0 6px;font-size:0.78rem">(' + sampleParts.join(" · ") + ')</span>' : '') + '</div>';
      }
    }
    lastClientMatched = matched;

    preview.innerHTML =
      '<div><strong>' + interfaceCount + '</strong> interface' + (interfaceCount === 1 ? "" : "s") +
      ' across <strong>' + names.length + '</strong> name' + (names.length === 1 ? "" : "s") +
      (client.approx ? ' <span class="hint" style="margin:0 0 0 6px;font-size:0.78rem">(upper bound — only-when-up applied at save)</span>' : '') +
      (warn ? ' <span style="color:var(--color-warning);margin-left:6px">⚠ above warn threshold (' + AUTO_MONITOR_INTERFACE_WARN_THRESHOLD + ')</span>' : '') +
      '</div>' +
      diffHtml +
      '<div class="hint" style="margin-top:0.3rem;font-size:0.78rem">From the last discovery interface set.</div>';
    preview.style.borderColor = warn ? "var(--color-warning)" : "";
    preview.dataset.interfaceCount = String(interfaceCount);
  }

  function runPreview() {
    if (!preview) return;
    // Stay quiet until the operator changes a selection (see userHasEdited).
    if (!userHasEdited) return;
    if (!integrationId) {
      preview.innerHTML = '<em>Preview becomes available after the integration is saved and discovery has run at least once.</em>';
      return;
    }
    var selection = _readAutoMonitorInterfaces(idPrefix);
    if (!selection) {
      preview.innerHTML = '<em>Enable a block and add at least one value to preview matches.</em>';
      preview.style.borderColor = "";
      // Keep both baselines in sync so the next toggle's diff is "from empty".
      lastSentSelection = null;
      lastClientMatched = null;
      preview.dataset.interfaceCount = "0";
      return;
    }

    // Fast path: everything except By LLDP can be previewed instantly from the
    // cached aggregate already loaded into this card — no server round-trip,
    // which on a large fleet was a multi-second-to-minutes live query that left
    // the box blank while it ran.
    if (!selection.byLldp) {
      if (!aggregateLoaded) {
        // Cache (instant) hasn't loaded for this card yet — e.g. a By pattern-
        // only selection where the names/types panels never triggered it. Load
        // it; renderNamesList re-fires the preview once rows are in.
        preview.innerHTML = '<em>Loading interface data…</em>';
        loadAggregate();
        return;
      }
      var client = computeClientPreview(selection);
      if (client) { renderClientPreview(client); return; }
    }

    // By LLDP needs topology the cache doesn't hold → live server preview.
    // Pass the previously-sent selection as the baseline. Backend computes
    // both pin sets in one DB fetch and returns a `diff` block with the
    // per-(asset, ifName) add/remove counts.
    preview.innerHTML = '<em>Computing matches…</em>';
    var requestBaseline = lastSentSelection;
    api.integrations.interfaceAggregatePreview(integrationId, { class: klass, selection: selection, baselineSelection: requestBaseline }).then(function (r) {
      // Update the baseline for the NEXT request right after a successful
      // round-trip — preserves per-click semantics even if the user clicks
      // a second time while the first preview is still in flight (debounce
      // collapses bursts; whichever response lands last wins, and the next
      // baseline tracks that one).
      lastSentSelection = selection;
      var warn = r.interfaceCount > AUTO_MONITOR_INTERFACE_WARN_THRESHOLD;
      var sample = (r.sampleDevices || []).slice(0, 5).map(function (d) {
        return escapeHtml(d.hostname || "(unnamed)") + ' <span class="hint" style="margin:0;font-size:0.78rem">(' + d.pinNames.length + ')</span>';
      }).join(" · ");
      // Diff badge. Hidden when there's no change since the last request.
      // Renders side-by-side green (+N added) and amber (−N removed) so an
      // operator can see at a glance whether a click broadened or narrowed
      // the pinned set. Sample additions/removals show a few illustrative
      // (hostname / ifName) pairs without overwhelming the box.
      var diff = r.diff || null;
      var diffHtml = "";
      if (diff && (diff.addedCount > 0 || diff.removedCount > 0)) {
        var parts = [];
        if (diff.addedCount > 0) {
          parts.push('<span style="color:var(--color-success);font-weight:600">+' + diff.addedCount + ' added</span>');
        }
        if (diff.removedCount > 0) {
          parts.push('<span style="color:var(--color-warning);font-weight:600">−' + diff.removedCount + ' removed</span>');
        }
        var sampleParts = [];
        var addedSample = (diff.addedSample || []).slice(0, 3).map(function (e) {
          return '<span style="color:var(--color-success)">+' + escapeHtml(e.hostname || "(unnamed)") + ' / ' + escapeHtml(e.ifName) + '</span>';
        });
        var removedSample = (diff.removedSample || []).slice(0, 3).map(function (e) {
          return '<span style="color:var(--color-warning)">−' + escapeHtml(e.hostname || "(unnamed)") + ' / ' + escapeHtml(e.ifName) + '</span>';
        });
        sampleParts = addedSample.concat(removedSample);
        diffHtml =
          '<div style="margin-top:0.3rem;font-size:0.82rem">Change since last edit: ' + parts.join(" · ") +
          (sampleParts.length > 0 ? ' <span class="hint" style="margin:0 0 0 6px;font-size:0.78rem">(' + sampleParts.join(" · ") + ')</span>' : '') +
          '</div>';
      }
      preview.innerHTML =
        '<div><strong>' + r.interfaceCount + '</strong> interface' + (r.interfaceCount === 1 ? "" : "s") +
        ' on <strong>' + r.deviceCount + '</strong> device' + (r.deviceCount === 1 ? "" : "s") +
        ' (max ' + r.perDeviceMax + '/device)' +
        (warn ? ' <span style="color:var(--color-warning);margin-left:6px">⚠ above warn threshold (' + AUTO_MONITOR_INTERFACE_WARN_THRESHOLD + ')</span>' : '') +
        '</div>' +
        diffHtml +
        (sample ? '<div style="margin-top:0.3rem;font-size:0.82rem">First matches: ' + sample + '</div>' : '');
      preview.style.borderColor = warn ? "var(--color-warning)" : "";
      // Cache the latest interface count on the card for the Save handler to read.
      preview.dataset.interfaceCount = String(r.interfaceCount);
    }).catch(function (err) {
      preview.innerHTML = '<span style="color:var(--color-danger)">Preview failed: ' + escapeHtml(err.message || "unknown error") + '</span>';
    });
  }

  // Wire master checkboxes — each one toggles its panel and re-runs preview.
  for (var i = 0; i < masters.length; i++) {
    masters[i].addEventListener("change", function () { syncMasterVisibility(); onUserChange(); });
  }

  // Patterns block — textarea, regex/wildcard radio, onlyUp.
  var patternsEls = [
    document.getElementById(idPrefix + "patterns"),
    document.getElementById(idPrefix + "patterns-onlyUp"),
  ];
  patternsEls.forEach(function (el) {
    if (!el) return;
    el.addEventListener("input", onUserChange);
    el.addEventListener("change", onUserChange);
  });
  var patternsModeRadios = document.getElementsByName(idPrefix + "patterns-mode");
  for (var pm = 0; pm < patternsModeRadios.length; pm++) {
    patternsModeRadios[pm].addEventListener("change", onUserChange);
  }

  // Test button — preview the patterns block in isolation so the operator can
  // verify their regex without the noise of the other blocks. Hits the same
  // /interface-aggregate/preview endpoint with just byPatterns populated.
  var testBtn = document.getElementById(idPrefix + "patterns-test");
  var testOut = document.getElementById(idPrefix + "patterns-test-result");
  if (testBtn && testOut) {
    testBtn.addEventListener("click", function () {
      if (!integrationId) return;
      var ta = document.getElementById(idPrefix + "patterns");
      var raw = ta ? String(ta.value || "") : "";
      var patterns = raw.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (patterns.length === 0) {
        testOut.style.display = "";
        testOut.innerHTML = '<span style="color:var(--color-warning)">Enter at least one pattern to test.</span>';
        return;
      }
      var modeRs = document.getElementsByName(idPrefix + "patterns-mode");
      var isRegex = false;
      for (var pr = 0; pr < modeRs.length; pr++) { if (modeRs[pr].checked && modeRs[pr].value === "regex") { isRegex = true; break; } }
      var ouEl = document.getElementById(idPrefix + "patterns-onlyUp");
      var selection = { byPatterns: { patterns: patterns, regex: isRegex, onlyUp: ouEl ? ouEl.checked === true : false } };
      testBtn.disabled = true;
      var prevLabel = testBtn.textContent;
      testBtn.textContent = "Testing…";
      testOut.style.display = "";
      testOut.innerHTML = '<em>Running…</em>';
      api.integrations.interfaceAggregatePreview(integrationId, { class: klass, selection: selection }).then(function (r) {
        var sample = (r.sampleDevices || []).slice(0, 5).map(function (d) {
          var names = (d.pinNames || []).slice(0, 6).join(", ");
          if ((d.pinNames || []).length > 6) names += ", …";
          return escapeHtml(d.hostname || "(unnamed)") + ' <span class="hint" style="margin:0">[' + escapeHtml(names) + ']</span>';
        }).join("<br>");
        testOut.innerHTML =
          '<div><strong>' + r.interfaceCount + '</strong> match' + (r.interfaceCount === 1 ? "" : "es") +
          ' on <strong>' + r.deviceCount + '</strong> device' + (r.deviceCount === 1 ? "" : "s") +
          (r.deviceCount > 0 ? ' (max ' + r.perDeviceMax + '/device)' : '') + '</div>' +
          (sample ? '<div style="margin-top:0.3rem">' + sample + '</div>' : '');
      }).catch(function (err) {
        testOut.innerHTML = '<span style="color:var(--color-danger)">' + escapeHtml(err.message || "Test failed") + '</span>';
      }).finally(function () {
        testBtn.disabled = false;
        testBtn.textContent = prevLabel;
      });
    });
  }

  // Types block.
  var typeBoxes = document.querySelectorAll('input[data-type-checkbox="1"][id^="' + idPrefix + 'type-"]');
  for (var t = 0; t < typeBoxes.length; t++) typeBoxes[t].addEventListener("change", onUserChange);
  var typesOnlyUp = document.getElementById(idPrefix + "types-onlyUp");
  if (typesOnlyUp) typesOnlyUp.addEventListener("change", onUserChange);
  // Wire the include-down control on the initial (saved) render; renderTypesList
  // re-wires it after a dynamic re-render.
  wireInclDown();

  // LLDP block.
  var lldpBoxes = document.querySelectorAll('input[data-lldp-checkbox="1"][id^="' + idPrefix + 'lldp-"]');
  for (var lb = 0; lb < lldpBoxes.length; lb++) lldpBoxes[lb].addEventListener("change", onUserChange);

  // Filter (By name) — view-only, debounce-free; never marks an edit.
  var namesFilter = document.getElementById(idPrefix + "names-filter");
  if (namesFilter) namesFilter.addEventListener("input", applyNamesFilter);

  // Initial visibility sync.
  syncMasterVisibility();
  // Run initial preview if anything is enabled.
  schedulePreview();
}

// FortiGate subtab variant — "Add as Monitored" only, wrapped in a styled
// box matching the Auto-Monitor Interfaces card. The SNMP-sysLocation
// pull/push toggles moved out to the top-level Geographic Location tab on
// the integration's Edit modal (see geographicLocationFormHTML). FortiGates
// always get the integration source link stamped at discovery, which drives
// the polling-method resolver to REST API by default, so no per-class
// credential picker is needed here.
//
// `fixedOn` (standalone FortiGate, business rule 127): the gate is always
// monitored, so there is no button — the hidden checkbox stays checked for
// the save collector and the server stamps the flag regardless.
function _fortigateAddMonitoredHTML(idPrefix, currentAddAsMonitored, fixedOn) {
  if (fixedOn) {
    return '<div style="background:color-mix(in srgb, var(--color-accent) 6%, transparent);border:1px solid color-mix(in srgb, var(--color-accent) 20%, transparent);border-radius:var(--radius-md);padding:0.75rem 0.9rem;margin-bottom:1rem">' +
        '<input type="checkbox" id="' + idPrefix + 'addAsMonitored" checked style="display:none">' +
        '<div style="font-weight:500;margin-bottom:0.4rem">Auto-Monitor FortiGate: always on</div>' +
        '<p class="hint" style="margin:0">A standalone FortiGate integration always monitors its gate: discovery already holds a working API session to it. Switches and access points behind it keep their own toggles. To stop monitoring this gate, turn monitoring off on the asset itself; that per-asset choice is kept across discovery.</p>' +
      '</div>';
  }
  var enabled = currentAddAsMonitored === true;
  var btnClass = enabled ? "btn-danger" : "btn-primary";
  var btnLabel = enabled ? "Disable Auto-Monitoring" : "Enable Auto-Monitoring";
  return '<div style="background:color-mix(in srgb, var(--color-accent) 6%, transparent);border:1px solid color-mix(in srgb, var(--color-accent) 20%, transparent);border-radius:var(--radius-md);padding:0.75rem 0.9rem;margin-bottom:1rem">' +
      '<div class="form-group" style="display:flex;align-items:center;gap:12px;margin-bottom:0.4rem">' +
        '<input type="checkbox" id="' + idPrefix + 'addAsMonitored" ' + (enabled ? "checked" : "") + ' style="display:none">' +
        '<button type="button" class="btn ' + btnClass + '" data-auto-monitor-toggle="' + idPrefix + 'addAsMonitored" style="min-width:200px">' + btnLabel + '</button>' +
        '<div style="font-weight:500">Auto-Monitor FortiGates</div>' +
      '</div>' +
      '<p class="hint" style="margin:0">When enabled, every discovered FortiGate is monitored (the integration\'s API token already provides the probe path). Disabling sweeps existing FortiGates off monitoring on the next discovery cycle unless an operator has set a per-asset override. You\'ll be asked to confirm at Save Changes.</p>' +
    '</div>';
}

// Reactively enable/disable the sysLocation-coords + pushGeocodedCoords
// checkboxes. useSnmpLocationCoords needs the sysLocation pull (it geocodes
// the pulled string); push needs an ACTIVE geocode source — sysLocation
// coords enabled, or an address metavar named (FMG-only). Attached to window
// so the inline onchange/oninput handlers in geographicLocationFormHTML can
// reach it after the modal renders.
if (typeof window !== "undefined") {
  window._geoRecomputePush = function (prefix) {
    var pull = document.getElementById(prefix + "pullSnmpLocation");
    var use  = document.getElementById(prefix + "useSnmpLocationCoords");
    var addr = document.getElementById(prefix + "addressMetavar");
    var push = document.getElementById(prefix + "pushGeocodedCoords");
    var pullOn = pull && pull.checked === true;
    if (use) {
      use.disabled = !pullOn;
      if (!pullOn) use.checked = false;
      var useLbl = use.nextElementSibling;
      if (useLbl) useLbl.style.opacity = pullOn ? "1" : "0.5";
    }
    if (!push) return;
    var enabled = (use && use.checked === true) || (addr && addr.value.trim() !== "");
    push.disabled = !enabled;
    if (!enabled) push.checked = false;
    var lbl = push.nextElementSibling;
    if (lbl) lbl.style.opacity = enabled ? "1" : "0.5";
  };
}

// Body of the top-level "Geographic Location" tab on FMG and standalone
// FortiGate integration Edit/Create modals. Carries the pull-from-SNMP and
// push-geocoded-coords toggles plus (FMG only) the per-device metavar-name
// fields. The DOM ids stay `f-mon-fortigate-pullSnmpLocation` /
// `...pushGeocodedCoords` / `...latitudeMetavar` / `...longitudeMetavar` /
// `...addressMetavar` so `_readFortigateMonitorBlock()` finds them at save
// time. pushGeocodedCoords reactively enables when pull is on OR an address
// metavar is named (see window._geoRecomputePush).
function geographicLocationFormHTML(currentPullSnmpLocation, currentUseSnmpLocationCoords, currentPushGeocodedCoords, latMeta, lngMeta, addrMeta, integrationType) {
  var idPrefix = "f-mon-fortigate-";
  var pull = currentPullSnmpLocation === true;
  var useCoords = pull && currentUseSnmpLocationCoords === true;
  var push = currentPushGeocodedCoords === true;
  var isFmg = integrationType === "fortimanager";
  var addrSet = isFmg && typeof addrMeta === "string" && addrMeta.trim() !== "";
  var pushEnabled = useCoords || addrSet;
  // FMG-only metavar-name fields. Standalone FortiGate has no metavars, so the
  // block is omitted entirely there (push writes CMDB only).
  var metavarBlock = "";
  if (isFmg) {
    metavarBlock =
      formDivider() +
      sectionHeading("FortiManager metavariable names") +
      '<div>' +
        '<p class="hint" style="margin-top:0;margin-bottom:0.75rem">Names of the per-device FMG metavariables Polaris reads coordinates from and writes them back to. Leave Latitude / Longitude at the defaults unless your fleet uses a different naming scheme.</p>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">' +
          '<div class="form-group" style="margin:0">' +
            '<label for="' + idPrefix + 'latitudeMetavar">Latitude metavar</label>' +
            '<input type="text" id="' + idPrefix + 'latitudeMetavar" value="' + escapeHtml(latMeta || "Latitude") + '" placeholder="Latitude">' +
          '</div>' +
          '<div class="form-group" style="margin:0">' +
            '<label for="' + idPrefix + 'longitudeMetavar">Longitude metavar</label>' +
            '<input type="text" id="' + idPrefix + 'longitudeMetavar" value="' + escapeHtml(lngMeta || "Longitude") + '" placeholder="Longitude">' +
          '</div>' +
        '</div>' +
        '<div class="form-group" style="margin:0.75rem 0 0 0">' +
          '<label for="' + idPrefix + 'addressMetavar">Address metavar (optional)</label>' +
          '<input type="text" id="' + idPrefix + 'addressMetavar" value="' + escapeHtml(addrMeta || "") + '" placeholder="Leave blank to use SNMP sysLocation" oninput="window._geoRecomputePush(' + jsArg(idPrefix) + ')">' +
          '<p class="hint" style="margin-bottom:0">When set, Polaris reads this metavar\'s address string from each FortiGate and geocodes it <strong>instead of</strong> the SNMP sysLocation (SNMP is used only as a fallback when this metavar is empty). Use this if you don\'t want to pull sysLocation. Leave blank to rely on SNMP.</p>' +
        '</div>' +
      '</div>';
  }
  return sectionHeading("Location source") +
    '<p class="hint" style="margin:0 0 0.75rem 0">' +
      'Polaris resolves each FortiGate\'s location to map coordinates and (optionally) writes the result ' +
      'back to the device so it shows up correctly on the Polaris Device Map. The location string comes from ' +
      'the SNMP <code>sysLocation</code> (read via REST API — no separate SNMP credential needed)' +
      (isFmg ? ' or, in preference, a FortiManager address metavariable' : '') +
      ', geocoded via OpenStreetMap Nominatim. ' +
      'When the location is blank or doesn\'t geocode, Polaris falls back to ' +
      (isFmg ? 'FortiManager coordinate metavars / CMDB coords.' : 'the FortiGate\'s CMDB coords.') +
    '</p>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px;margin-bottom:0.4rem">' +
      '<input type="checkbox" id="' + idPrefix + 'pullSnmpLocation" ' + (pull ? "checked" : "") +
      ' onchange="window._geoRecomputePush(' + jsArg(idPrefix) + ')"' +
      ' style="width:auto">' +
      '<label for="' + idPrefix + 'pullSnmpLocation" style="margin:0">Pull SNMP sysLocation from each FortiGate</label>' +
    '</div>' +
    '<p class="hint" style="margin-bottom:1rem">Each discovery cycle, Polaris fetches <code>sysLocation</code> for every FortiGate via the FortiOS REST API. The value shows on the asset\'s General tab and pre-fills its Location field.</p>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px;margin-bottom:0.4rem">' +
      '<input type="checkbox" id="' + idPrefix + 'useSnmpLocationCoords" ' + (useCoords ? "checked" : "") + (pull ? "" : " disabled") +
      ' onchange="window._geoRecomputePush(' + jsArg(idPrefix) + ')"' +
      ' style="width:auto">' +
      '<label for="' + idPrefix + 'useSnmpLocationCoords" style="margin:0' + (pull ? "" : ";opacity:0.5") + '">Use sysLocation for map coordinates</label>' +
    '</div>' +
    '<p class="hint" style="margin-bottom:1rem">Geocodes the pulled <code>sysLocation</code> through OpenStreetMap Nominatim and uses the result as the FortiGate\'s Device Map position. <strong>When enabled, these geocoded coordinates override the latitude/longitude learned from the FortiGate' + (isFmg ? ' / FortiManager (coordinate metavars and CMDB GUI coords)' : ' (CMDB GUI coords)') + '.</strong> Requires the sysLocation pull above.</p>' +
    formDivider() +
    sectionHeading("Write-back") +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px;margin-bottom:0.4rem">' +
      '<input type="checkbox" id="' + idPrefix + 'pushGeocodedCoords" ' + (push ? "checked" : "") + (pushEnabled ? "" : " disabled") + ' style="width:auto">' +
      '<label for="' + idPrefix + 'pushGeocodedCoords" style="margin:0' + (pushEnabled ? "" : ";opacity:0.5") + '">Write geocoded coordinates back to the FortiGate</label>' +
    '</div>' +
    '<p class="hint" style="margin-bottom:0">When the geocoded coords differ from the FortiGate\'s current GUI values, update them on the device — ' +
      (isFmg
        ? 'writes to both the FortiManager coordinate metavars and the FortiGate\'s CMDB <code>gui-device-latitude</code> / <code>gui-device-longitude</code>. In FortiManager mode the change lands in FMG\'s CMDB but won\'t reach the live FortiGate until an operator runs Install Device Configuration in FMG.'
        : 'writes the FortiGate\'s CMDB <code>gui-device-latitude</code> / <code>gui-device-longitude</code>.') +
    '</p>' +
    (isFmg
      ? calloutHTML("warning", "FortiManager permission required",
          "Writing coordinates back to the per-device metavariables needs " +
          "<strong>Read-Write</strong> access to <strong>Policy &amp; Objects</strong> (Policy Package &amp; Objects) in the API user's " +
          "JSON API admin profile on FortiManager (<em>System Settings &rarr; Admin &rarr; Profile</em>). With read-only access Polaris can " +
          "still pull and geocode locations, but the write-back will fail.")
      : "") +
    metavarBlock;
}

// Renders the integration's Monitoring tab as a set of CLASS subtabs. Each
// class subtab carries:
//   1. Class-level header content (FortiGate: useDirect-toggle + discovery
//      defaults; FortiSwitch / FortiAP: direct-polling toggle + discovery
//      defaults; AD / Entra / WinSrv: no class header — they always discover)
//   2. Stream subtabs (Response Time / CPU+Memory / Temperature / Interfaces
//      / LLDP / Storage). FortiAP omits Storage.
//
// Class subtab set per integration type (see `_CLASS_SUBTAB_SPECS`):
//   fortimanager + fortigate → FortiGate / FortiSwitch / FortiAP
//   activedirectory + entraid + windowsserver → Workstations / Servers
//
// Phase 1 behaviour: every class subtab reads + writes the SAME flat
// `Integration.config.monitorSettings` JSON. The PRIMARY class subtab uses
// the legacy `f-mon-tier-...` / `f-mon-...` ids so `_readIntegrationCadenceForm`
// finds the values; secondary subtabs render a parallel, namespaced echo
// that doesn't get read on save. A banner inside each secondary subtab
// makes that explicit.
//
// opts: { integrationId, integrationType, integrationName, snmpCredentials,
//         monitorCredentialId, sshCredentialId, fortigateMonitor,
//         fortiswitchMonitor, fortiapMonitor, fmgDefaults?, pollInterval }
//   fmgDefaults is the FMG/FortiGate connection-form `defaults` blob — only
//   consulted for the relocated useDirect / discoveryParallelism /
//   fortigateApiUser / fortigateApiToken / fortigateVerifySsl fields when
//   `integrationType` is fortimanager.
function monitorSettingsFormHTML(s, opts) {
  s = s || {};
  opts = opts || {};
  var integrationType = opts.integrationType || "";
  var spec = _CLASS_SUBTAB_SPECS[integrationType];
  if (!spec) {
    // Fallback: no per-class layout known for this type — render a single
    // primary class subtab carrying every stream, no header content. Keeps
    // the modal functional for future integration types that haven't been
    // added to the spec yet.
    spec = { primary: "generic", classes: [{ key: "generic", label: "Monitoring" }] };
  }

  var isFmgFgt = integrationType === "fortimanager" || integrationType === "fortigate";
  var hasId    = !!opts.integrationId;
  var credentials = opts.snmpCredentials || [];

  // Per-class header content (auto-monitor, direct-polling toggles, etc.).
  // Built lazily per class inside the loop below.
  var fwFgCfg = opts.fortigateMonitor   || { addAsMonitored: false, autoMonitorInterfaces: null, pullSnmpLocation: false, useSnmpLocationCoords: false, pushGeocodedCoords: false, latitudeMetavar: "Latitude", longitudeMetavar: "Longitude", addressMetavar: "" };
  var fwSwCfg = opts.fortiswitchMonitor || { enabled: false, snmpCredentialId: null, sshCredentialId: null, addAsMonitored: false, autoMonitorInterfaces: null };
  var fwApCfg = opts.fortiapMonitor     || { enabled: false, snmpCredentialId: null, sshCredentialId: null, addAsMonitored: false, autoMonitorInterfaces: null };
  // AD/Entra/WindowsServer per-class blocks. The backend Zod schema names
  // them singularly (workstationMonitor / serverMonitor); the in-UI class
  // keys are plural (workstations / servers).
  var workstationCfg = opts.workstationMonitor || { addAsMonitored: false, autoMonitorInterfaces: null };
  var serverCfg      = opts.serverMonitor     || { addAsMonitored: false, autoMonitorInterfaces: null };
  // vCenter per-class blocks (vmMonitor = full workstation-style block;
  // hostMonitor = reduced — no agent deploy / auto-monitor on ESXi).
  var vmCfg   = opts.vmMonitor   || { addAsMonitored: false, autoMonitorInterfaces: null };
  var hostCfg = opts.hostMonitor || { addAsMonitored: false };
  // Azure Arc connected clusters — reduced block, same shape as hostCfg.
  var k8sCfg  = opts.k8sMonitor  || { addAsMonitored: false };
  // Unraid / TrueNAS — reduced blocks. The host defaults ON (the schema's
  // default), so an unsaved form shows it checked.
  var wlHostCfg = opts.hostMonitor      || { addAsMonitored: true };
  var wlVmCfg   = opts.vmMonitor        || { addAsMonitored: false };
  var ctrCfg    = opts.containerMonitor || { addAsMonitored: false };

  // Stash auto-monitor name seeds for the lazy-loaded checklists.
  function _amonSeedNames(sel) {
    if (!sel) return [];
    if (sel.byNames && Array.isArray(sel.byNames.names)) return sel.byNames.names.slice();
    if (sel.mode === "names" && Array.isArray(sel.names)) return sel.names.slice();
    return [];
  }
  // Storage "By name" seed — only the byNames block carries mount names.
  function _storSeedNames(sel) {
    if (sel && sel.byNames && Array.isArray(sel.byNames.names)) return sel.byNames.names.slice();
    return [];
  }
  if (typeof window !== "undefined" && isFmgFgt) {
    window["__autoMon_seed_f-mon-fortigate-amon-"]   = _amonSeedNames(fwFgCfg.autoMonitorInterfaces);
    window["__autoMon_seed_f-mon-fortiswitch-amon-"] = _amonSeedNames(fwSwCfg.autoMonitorInterfaces);
    window["__autoMon_seed_f-mon-fortiap-amon-"]     = _amonSeedNames(fwApCfg.autoMonitorInterfaces);
  }
  if (typeof window !== "undefined" && _isWsSrvRichType(integrationType)) {
    window["__autoMon_seed_f-mon-workstation-amon-"] = _amonSeedNames(workstationCfg.autoMonitorInterfaces);
    window["__autoMon_seed_f-mon-server-amon-"]      = _amonSeedNames(serverCfg.autoMonitorInterfaces);
    window["__autoMonStor_seed_f-mon-workstation-stor-"] = _storSeedNames(workstationCfg.autoMonitorStorage);
    window["__autoMonStor_seed_f-mon-server-stor-"]      = _storSeedNames(serverCfg.autoMonitorStorage);
  }
  if (typeof window !== "undefined" && integrationType === "vcenter") {
    window["__autoMon_seed_f-mon-vm-amon-"]     = _amonSeedNames(vmCfg.autoMonitorInterfaces);
    window["__autoMonStor_seed_f-mon-vm-stor-"] = _storSeedNames(vmCfg.autoMonitorStorage);
  }

  // Class subtab header content (Discovery defaults at top, then optional
  // Direct Polling toggle whose ON state reveals the per-class direct-polling
  // credentials AND the per-stream subtabs below). Returns "" for AD / Entra /
  // WindowsServer + the generic fallback — those have no per-class discovery-
  // time knobs to surface.
  //
  // For FortiGate on FMG integrations, the SNMP/SSH credential pickers from
  // `integrationMonitorOverrideHTML` are rendered hidden (display:none) at the
  // bottom of the section so the save-path reader (`_polarisReadCredentials`
  // / form serializer) still finds the `f-mon-credential` /
  // `f-mon-credential-ssh` select elements. Per-stream credential pickers
  // inside each stream subtab are the operator-facing surface. We pre-mirror
  // the SNMP value from the Response Time stream's snmp credential picker on
  // form change so a save still serializes the operator's intent.
  // Per-class header content. Each FMG/FortiGate class subtab gets an
  // "Auto-monitoring" section header followed by two side-by-side concept
  // cards (addAsMonitored, then Auto-Monitor Interfaces), then any class-
  // specific tail (Direct Polling toggle for FortiSwitch / FortiAP; FMG's
  // Direct Polling block for the FortiGate subtab on FMG integrations).
  // The "Discovery defaults" heading + description that used to lead the
  // section have been dropped — the "Auto-monitoring" header replaces them
  // positionally, and the help text inside each card is the only descriptor
  // operators need.
  function autoMonitoringHeader() {
    return '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin:0 0 0.75rem 0">Auto-monitoring</p>';
  }
  function headerForClass(klass) {
    if (klass === "fortigate" && isFmgFgt) {
      // Auto-Monitor Interfaces is gated on addAsMonitored — auto-monitor
      // pins interfaces on newly-discovered assets to be polled on the fast
      // cadence, which only makes sense when those assets are being added
      // as monitored. _wireMonitoringTabSubtabs wires a change listener on
      // the addAsMonitored checkbox to toggle this wrapper's display.
      var fgFixedOn = integrationType === "fortigate";
      var fgAutoMonWrapHidden = (fgFixedOn || fwFgCfg.addAsMonitored === true) ? "" : "display:none";
      var autoMonitoringSection =
        '<section style="margin-bottom:1.25rem">' +
          autoMonitoringHeader() +
          _fortigateAddMonitoredHTML(
            "f-mon-fortigate-",
            fwFgCfg.addAsMonitored === true,
            fgFixedOn,
          ) +
          '<div id="f-mon-fortigate-automon-wrap" style="' + fgAutoMonWrapHidden + '">' +
            _autoMonitorInterfacesHTML("f-mon-fortigate-amon-", "FortiGate", fwFgCfg.autoMonitorInterfaces || null, "names", hasId) +
          '</div>' +
        '</section>';

      // Save-path continuity: keep the legacy SNMP/SSH credential pickers in
      // the DOM but invisible. `_syncCredentialPickerVisibility` normally
      // shows/hides these based on per-stream polling-method selections; we
      // need them to stay hidden no matter what under FortiGate now, so we
      // wrap them in a display:none container that nothing flips back on.
      var hiddenLegacyCreds =
        '<div id="f-mon-fortigate-legacy-creds" style="display:none" aria-hidden="true">' +
          integrationMonitorOverrideHTML(credentials, opts.monitorCredentialId, opts.sshCredentialId || null) +
        '</div>';

      // FMG-only: Direct Polling toggle + revealable inner block (REST
      // credentials). Standalone FortiGate is always direct so this block
      // is omitted entirely there.
      var directBlock = (integrationType === "fortimanager")
        ? _fmgDirectModeBlockHTML(opts.fmgDefaults || {})
        : "";

      return autoMonitoringSection + directBlock + hiddenLegacyCreds;
    }
    if (klass === "fortiswitch" && isFmgFgt) {
      // Order: Auto-monitoring header → addAsMonitored card → Auto-Monitor
      // Interfaces card (gated on addAsMonitored) → Direct Polling toggle +
      // per-class credentials. Stream subtabs (rendered by
      // _classSubtabBodyHTML) sit below the Direct Polling toggle and are
      // gated by it.
      var swAutoMonWrapHidden = (fwSwCfg.addAsMonitored === true) ? "" : "display:none";
      return '<section style="margin-bottom:1.25rem">' +
          autoMonitoringHeader() +
          _classAddAsMonitoredHTML("f-mon-fortiswitch-", "FortiSwitch", fwSwCfg.addAsMonitored === true) +
          '<div id="f-mon-fortiswitch-automon-wrap" style="' + swAutoMonWrapHidden + '">' +
            _autoMonitorInterfacesHTML("f-mon-fortiswitch-amon-", "FortiSwitch", fwSwCfg.autoMonitorInterfaces || null, "wildcard", hasId) +
          '</div>' +
          _classDirectPollHTML("f-mon-fortiswitch-", "FortiSwitch", credentials, fwSwCfg.enabled === true, fwSwCfg.snmpCredentialId || null, fwSwCfg.sshCredentialId || null) +
        '</section>';
    }
    if (klass === "fortiap" && isFmgFgt) {
      var apAutoMonWrapHidden = (fwApCfg.addAsMonitored === true) ? "" : "display:none";
      return '<section style="margin-bottom:1.25rem">' +
          autoMonitoringHeader() +
          _classAddAsMonitoredHTML("f-mon-fortiap-", "FortiAP", fwApCfg.addAsMonitored === true) +
          '<div id="f-mon-fortiap-automon-wrap" style="' + apAutoMonWrapHidden + '">' +
            _autoMonitorInterfacesHTML("f-mon-fortiap-amon-", "FortiAP", fwApCfg.autoMonitorInterfaces || null, "type", hasId) +
          '</div>' +
          _classDirectPollHTML("f-mon-fortiap-", "FortiAP", credentials, fwApCfg.enabled === true, fwApCfg.snmpCredentialId || null, fwApCfg.sshCredentialId || null) +
        '</section>';
    }
    // AD / Entra Workstations + Servers subtabs. addAsMonitored is honored by
    // discovery (monitorOverrideService); when it's on, the Auto-Monitor
    // Interfaces + Storage cards become available (gated like the FortiGate
    // branch). These devices report interfaces/mounts via the Polaris Agent, so
    // the pickers populate only after agents are deployed and reporting; the
    // discovery-time apply pass pins whatever exists each cycle. Below the
    // monitoring cards sits the Agent Auto-Deploy card (independent of
    // addAsMonitored — deploying the agent IS how these devices get monitored).
    // WindowsServer keeps the simple addAsMonitored-only card (no agent deploy
    // / auto-monitor wiring on that path yet).
    var wsLikeAdEntra = _isWsSrvRichType(integrationType);
    if (klass === "workstations" || klass === "workstation") {
      if (!wsLikeAdEntra) {
        return '<section style="margin-bottom:1.25rem">' + autoMonitoringHeader() +
          _classAddAsMonitoredHTML("f-mon-workstation-", "workstation", workstationCfg.addAsMonitored === true) + '</section>';
      }
      var wsWrapHidden = (workstationCfg.addAsMonitored === true) ? "" : "display:none";
      return '<section style="margin-bottom:1.25rem">' +
          autoMonitoringHeader() +
          _classAddAsMonitoredHTML("f-mon-workstation-", "workstation", workstationCfg.addAsMonitored === true) +
          '<div id="f-mon-workstation-automon-wrap" style="' + wsWrapHidden + '">' +
            _autoMonitorInterfacesHTML("f-mon-workstation-amon-", "workstation", workstationCfg.autoMonitorInterfaces || null, "names", hasId, { hideLldp: true }) +
            _autoMonitorStorageHTML("f-mon-workstation-stor-", "workstation", workstationCfg.autoMonitorStorage || null, hasId) +
          '</div>' +
          _agentDeployHTML("f-mon-workstation-deploy-", "workstation", workstationCfg.agentDeploy || null, credentials) +
        '</section>';
    }
    if (klass === "servers" || klass === "server") {
      if (!wsLikeAdEntra) {
        return '<section style="margin-bottom:1.25rem">' + autoMonitoringHeader() +
          _classAddAsMonitoredHTML("f-mon-server-", "server", serverCfg.addAsMonitored === true) + '</section>';
      }
      var srvWrapHidden = (serverCfg.addAsMonitored === true) ? "" : "display:none";
      return '<section style="margin-bottom:1.25rem">' +
          autoMonitoringHeader() +
          _classAddAsMonitoredHTML("f-mon-server-", "server", serverCfg.addAsMonitored === true) +
          '<div id="f-mon-server-automon-wrap" style="' + srvWrapHidden + '">' +
            _autoMonitorInterfacesHTML("f-mon-server-amon-", "server", serverCfg.autoMonitorInterfaces || null, "names", hasId, { hideLldp: true }) +
            _autoMonitorStorageHTML("f-mon-server-stor-", "server", serverCfg.autoMonitorStorage || null, hasId) +
          '</div>' +
          _agentDeployHTML("f-mon-server-deploy-", "server", serverCfg.agentDeploy || null, credentials) +
        '</section>';
    }
    // vCenter VMs — full workstation-style card set: addAsMonitored →
    // auto-monitor interfaces/storage (agent-fed, gated on addAsMonitored) →
    // agent auto-deploy. Per-minute CPU/RAM rides the "vcenter" polling
    // method (the CPU/Memory stream subtab default) with no agent needed.
    if (klass === "vms" || klass === "virtual_machine") {
      var vmWrapHidden = (vmCfg.addAsMonitored === true) ? "" : "display:none";
      return '<section style="margin-bottom:1.25rem">' +
          autoMonitoringHeader() +
          _classAddAsMonitoredHTML("f-mon-vm-", "virtual machine", vmCfg.addAsMonitored === true) +
          '<div id="f-mon-vm-automon-wrap" style="' + vmWrapHidden + '">' +
            _autoMonitorInterfacesHTML("f-mon-vm-amon-", "virtual machine", vmCfg.autoMonitorInterfaces || null, "names", hasId, { hideLldp: true }) +
            _autoMonitorStorageHTML("f-mon-vm-stor-", "virtual machine", vmCfg.autoMonitorStorage || null, hasId) +
          '</div>' +
          _agentDeployHTML("f-mon-vm-deploy-", "virtual machine", vmCfg.agentDeploy || null, credentials) +
        '</section>';
    }
    // vCenter ESXi hosts — addAsMonitored only. No agent (ESXi runs no
    // third-party binary) and no auto-monitor pin cards: the host's interfaces
    // and mounted datastores arrive from the "vcenter" polling method on the
    // stream subtabs above, and operators pin the ones they want to alert on
    // from the asset's System tab or through Mass Pinning.
    if (klass === "hosts" || klass === "hypervisor") {
      return '<section style="margin-bottom:1.25rem">' + autoMonitoringHeader() +
        _classAddAsMonitoredHTML("f-mon-host-", "ESXi host", hostCfg.addAsMonitored === true) + '</section>';
    }
    // Azure Arc connected Kubernetes clusters — addAsMonitored only. A cluster
    // runs no Polaris Agent and reports no interfaces or mounts, so it gets the
    // same reduced card as an ESXi host.
    if (klass === "clusters" || klass === "kubernetes_cluster") {
      return '<section style="margin-bottom:1.25rem">' + autoMonitoringHeader() +
        _classAddAsMonitoredHTML("f-mon-clusters-", "Kubernetes cluster", k8sCfg.addAsMonitored === true) + '</section>';
    }
    // Unraid / TrueNAS — addAsMonitored only, per class. Everything else the
    // workloads report rides the "unraid" / "truenas" / "proxmox" polling
    // method on the stream subtabs; nothing is installed and nothing is pinned.
    if (klass === "wlhosts") {
      return '<section style="margin-bottom:1.25rem">' + autoMonitoringHeader() +
        _classAddAsMonitoredHTML("f-mon-wlhost-", integrationType === "proxmox" ? "node" : "host", wlHostCfg.addAsMonitored !== false) + '</section>';
    }
    if (klass === "wlvms") {
      return '<section style="margin-bottom:1.25rem">' + autoMonitoringHeader() +
        _classAddAsMonitoredHTML("f-mon-wlvm-", "virtual machine", wlVmCfg.addAsMonitored === true) + '</section>';
    }
    if (klass === "containers") {
      return '<section style="margin-bottom:1.25rem">' + autoMonitoringHeader() +
        _classAddAsMonitoredHTML("f-mon-ctr-", integrationType === "truenas" ? "App" : "container", ctrCfg.addAsMonitored === true) + '</section>';
    }
    return "";
  }

  // Build the class-level tab list.
  var primaryLabel = (spec.classes.find(function (c) { return c.key === spec.primary; }) || spec.classes[0]).label;
  var classTabs = spec.classes.map(function (c) {
    return {
      key: c.key,
      label: c.label,
      html: _classSubtabBodyHTML({
        integrationType: integrationType,
        klass:           c.key,
        isPrimary:       c.key === spec.primary,
        primaryLabel:    primaryLabel,
        settings:        s,
        // Phase 2 — pick the per-class streams block matching this class.
        // FMG / FortiGate route to fortigateMonitor / fortiswitchMonitor /
        // fortiapMonitor; AD / Entra / WinSrv route to workstationMonitor /
        // serverMonitor. Missing block → undefined → overlay no-ops →
        // legacy flat baseline shows through (unmigrated install).
        classStreams: _classStreamsBlockFor(c.key, opts),
        credentials:     credentials,
        headerHtml:      headerForClass(c.key),
        fmgDefaults:     opts.fmgDefaults || {},
        fortigateMonitor:   opts.fortigateMonitor   || {},
        fortiswitchMonitor: opts.fortiswitchMonitor || {},
        fortiapMonitor:     opts.fortiapMonitor     || {},
        workstationMonitor: opts.workstationMonitor || {},
        serverMonitor:      opts.serverMonitor     || {},
        vmMonitor:          opts.vmMonitor         || {},
        hostMonitor:        opts.hostMonitor       || {},
        containerMonitor:   opts.containerMonitor  || {},
        // Hide per-stream credential rows on FortiSwitch + FortiAP class
        // subtabs — the class-level SNMP/SSH credential picker inside the
        // Direct Polling block is authoritative for those classes (managed
        // switches and APs use one credential across every stream).
        showStreamCredentials: !(c.key === "fortiswitch" || c.key === "fortiap"),
        // FortiLink LLDP-exclusion toggle — surfaced on the FortiGate LLDP
        // stream subtab. Integration-level (config.excludeFortilinkLldp).
        excludeFortilinkLldp: opts.excludeFortilinkLldp === true,
      }),
    };
  });

  // Integration-level presence-verification toggle (AD / Entra only).
  // Directory timestamps don't update Asset.lastSeen; this post-discovery
  // pass establishes network presence instead (agent heartbeat → monitor
  // probe → single-ping fallback). Stored as config.verifyPresence; read on
  // save by _readVerifyPresenceToggle(). Default ON.
  var verifyPresenceHtml = "";
  if (integrationType === "activedirectory" || integrationType === "entraid"
      || integrationType === "vcenter" || integrationType === "azurearc") {
    var vpChecked = opts.verifyPresence === false ? "" : "checked";
    verifyPresenceHtml = '<div class="form-group" style="display:flex;align-items:flex-start;gap:8px;margin:0 0 1rem 0">' +
        '<input type="checkbox" id="f-verifyPresence" ' + vpChecked + ' style="width:auto;margin-top:3px">' +
        '<div>' +
          '<label for="f-verifyPresence" style="margin:0">Verify network presence after discovery (ICMP fallback)</label>' +
          '<p class="hint" style="margin:0.15rem 0 0 0">Directory timestamps (Intune sync, AD last logon) are activity signals, not network presence, and do not update an asset&rsquo;s Last Seen. After each discovery Polaris confirms presence from the agent heartbeat or monitor probes, falling back to a single ping for devices with neither. A failed ping never marks a device stale &mdash; it simply leaves Last Seen unchanged.</p>' +
        '</div>' +
      '</div>';
  }

  // The address-book directory controls used to live here. They moved to a
  // tab of their own (directoryFormHTML): this tab's own header describes
  // per-class polling, cadences and credentials, and neither reading the GAL
  // nor storing it is any of those things.

  return '<section>' +
      '<p class="hint" style="margin:0 0 0.85rem 0">' +
        "Per-class polling, cadences, and credentials for assets discovered by this integration. " +
        "A class override (Assets page → Monitoring Settings) or a per-asset override on the asset itself takes priority." +
      '</p>' +
      verifyPresenceHtml +
      tabbedBodyHTML("intg-mon-class", classTabs) +
    '</section>';
}

// Direct-polling toggle + REST API credentials for FMG-managed FortiGates.
// Rendered inside the FortiGate class subtab of the Monitoring tab. Mirrors
// the FortiSwitch/FortiAP "Direct Polling" pattern visually (compact toggle
// + revealable inner block) — the legacy DOM ids (`f-useDirect`,
// `f-direct-mode-block`, `f-discoveryParallelism`, `f-fortigateApiUser`,
// `f-fortigateApiToken`, `f-fortigateVerifySsl`) all stay so
// `getFormConfig()` and `_fmgToggleDirectMode()` keep reading them unchanged.
// UI semantic: checked = direct (useProxy=false); unchecked = proxy.
//
// `#f-direct-mode-block` now wraps ONLY the genuinely direct-mode-only knob
// (parallelism). The FortiGate REST credentials moved out below it and are
// always visible, because they are not a property of the transport — see the
// comment at that block.
function _fmgDirectModeBlockHTML(d) {
  return sectionHeading("Direct polling") +
    '<div style="background:color-mix(in srgb, var(--color-accent) 8%, transparent);border:1px solid color-mix(in srgb, var(--color-accent) 20%, transparent);border-radius:var(--radius-md);padding:0.75rem 0.9rem;margin-bottom:1rem">' +
      '<div class="form-group" style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<input type="checkbox" id="f-useDirect" ' + (d.useProxy === false ? "checked" : "") + ' style="width:auto" onchange="_fmgToggleDirectMode(this.checked)">' +
        '<label for="f-useDirect" style="margin:0;font-weight:500">Direct Polling</label>' +
      '</div>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);line-height:1.5;margin:0 0 0.6rem 0">Bypass FortiManager proxy to directly poll discovered FortiGates. Some information is still gathered through FortiManager.</p>' +
      '<div id="f-direct-mode-block" style="' + (d.useProxy === false ? "" : "display:none;") + 'border-top:1px solid color-mix(in srgb, var(--color-accent) 20%, transparent);padding-top:0.75rem;margin-top:0.25rem">' +
        '<div class="form-group" style="margin-bottom:0"><label>Parallel FortiGate Queries</label><div style="display:flex;align-items:center;gap:8px"><input type="number" id="f-discoveryParallelism" value="' + (d.useProxy === false ? (d.discoveryParallelism || 5) : 1) + '" min="1" max="20" style="width:80px"><span id="f-parallelism-note" style="color:var(--color-text-tertiary);font-size:0.85rem">gates at once</span></div><p class="hint">Up to 20 FortiGates concurrently. Recommended when monitoring more than 10 FortiGates — proxy mode polls them one at a time.</p></div>' +
      '</div>' +
      // Credentials sit OUTSIDE #f-direct-mode-block on purpose. They are not
      // direct-mode-only: every FortiOS REST monitoring collector builds its
      // config from these same two fields via buildFortinetConfig(), in BOTH
      // transports — so while they lived inside the collapsible block, a
      // proxy-mode integration had no way to supply the credential its own
      // CPU/memory, temperature and interface streams need, and those streams
      // failed with "FortiManager direct-mode API token not configured" on
      // every tick with no field on screen to fix it.
      '<div style="border-top:1px solid color-mix(in srgb, var(--color-accent) 20%, transparent);padding-top:0.75rem;margin-top:0.75rem">' +
        '<div style="font-weight:500;margin-bottom:0.35rem">FortiGate REST credentials</div>' +
        '<p style="font-size:0.82rem;color:var(--color-text-secondary);line-height:1.5;margin:0 0 0.6rem 0">Used by Direct Polling above, and by any monitoring stream set to REST API — including under FortiManager proxy. Leave blank if every stream uses ICMP or SNMP.</p>' +
        '<div class="form-group"><label>FortiGate API User</label><input type="text" id="f-fortigateApiUser" value="' + escapeHtml(d.fortigateApiUser || "") + '" placeholder="e.g. polaris-ro"><p class="hint">REST API admin username configured on each managed FortiGate</p></div>' +
        '<div class="form-group"><label>FortiGate API Token</label><input type="password" id="f-fortigateApiToken" value="' + (d.fortigateApiTokenPlaceholder ? "" : escapeHtml(d.fortigateApiToken || "")) + '" placeholder="' + (d.fortigateApiTokenPlaceholder || "Bearer token") + '"><p class="hint">Bearer token for the above admin. Must be the same across all managed FortiGates — where a gate has its own api-user, leave this blank (or let it stand for the rest of the fleet) and select a REST API credential on that device’s stream instead.</p></div>' +
        '<div class="form-group" style="display:flex;align-items:center;gap:8px;margin-bottom:0">' +
          '<input type="checkbox" id="f-fortigateVerifySsl" ' + (d.fortigateVerifySsl ? "checked" : "") + ' style="width:auto">' +
          '<label for="f-fortigateVerifySsl" style="margin:0">Verify SSL certificate on FortiGates</label>' +
        '</div>' +
        '<p class="hint" style="color:var(--color-warning)">Leave enabled. Disabling lets a network attacker intercept the direct FortiGate REST connections and capture the API token. Disable only for FortiGates with self-signed certificates you cannot replace.</p>' +
      '</div>' +
    '</div>';
}

// Walk every polling-method <select> rendered by _polarisPollingDropdownHTML
// (identified by data-poll-source / data-poll-stream attributes) inside the
// given container and rewrite the first option's text — the "Inherit (…)"
// label — so it reflects the current Direct Polling state. Called from the
// FMG `f-useDirect` toggle's change handler so flipping the toggle live
// updates every per-stream dropdown's label without re-rendering and losing
// the operator's current selections.
function _relabelInheritOptions(container, fmgDirectMode) {
  if (!container) container = document;
  var selects = container.querySelectorAll("select[data-poll-source][data-poll-stream]");
  for (var i = 0; i < selects.length; i++) {
    var sel = selects[i];
    var source = sel.getAttribute("data-poll-source");
    var stream = sel.getAttribute("data-poll-stream");
    if (!sel.options || sel.options.length === 0) continue;
    var firstOpt = sel.options[0];
    if (firstOpt.value !== "") continue; // safety: only touch the Inherit row
    var defaultMethod = _polarisSourceDefaultPolling(source, stream, {
      fortiosRestUnavailable: _fmgFortiosRestUnavailable(source),
      klass: sel.getAttribute("data-poll-class") || "",
    });
    var sourceLabel = _polarisSourceLabel(source, { fmgDirectMode: fmgDirectMode === true });
    firstOpt.textContent = defaultMethod
      ? "Inherit (Source " + sourceLabel + ": " + _POLLING_LABELS[defaultMethod] + ")"
      : "Inherit (Source " + sourceLabel + ": not delivered)";
  }
}

// Lock every polling-method dropdown that cannot produce data, and say why.
//
// This replaces the old behaviour of HIDING the FortiGate class's stream
// subtabs whenever proxy mode was on. Hiding explained nothing and left the
// stored values invisibly in force; locking shows the operator what is
// inherited and names the one thing that would unlock it.
//
// Non-destructive in both directions: the stored per-stream values are never
// rewritten (the disabled control still round-trips its own value on save), and
// the resolver independently skips a stored rest_api it cannot honour — so
// supplying a token restores the operator's original choices intact.
//
// A managed switch/AP's response time is left ENABLED: that read works through
// the proxy on FMG's own credential.
function _applyFortiosRestLocks(rootEl, integrationType) {
  var root = rootEl || document;
  var locked = _fmgFortiosRestUnavailable(integrationType);
  var selects = root.querySelectorAll("select[data-poll-source][data-poll-stream]");
  for (var i = 0; i < selects.length; i++) {
    var sel = selects[i];
    if (sel.getAttribute("data-poll-source") !== "fortimanager") continue;
    var stream = sel.getAttribute("data-poll-stream");
    var klass  = sel.getAttribute("data-poll-class") || "";
    // The dropdown labels cpuMemory as "telemetry" for legacy-default reasons;
    // normalize before asking the shared predicate.
    var canonicalStream = stream === "telemetry" ? "cpuMemory" : stream;
    var lockThis = locked && !_fortiosRestUsable(canonicalStream, klass);
    sel.disabled = lockThis;
    sel.title = lockThis
      ? "Locked: FortiManager proxy mode with no FortiGate API token cannot make a FortiOS REST call. Set a FortiGate API Token on the General tab, or enable Direct Polling."
      : "";
  }
  var notes = root.querySelectorAll("[data-fortios-rest-note]");
  for (var n = 0; n < notes.length; n++) {
    notes[n].style.display = locked ? "" : "none";
  }
}

// Per-stream credential-row reactivity. Each polling-method <select> rendered
// by _polarisPollingDropdownHTML carries data-poll-source + data-poll-stream
// attributes and its DOM id; _classStreamSubtabHTML emits three sibling
// credential rows below each dropdown at `<pollId>-credrow-snmp` /
// `-credrow-ssh` / `-credrow-winrm`, all default display:none. This helper
// walks every such dropdown inside `rootEl` (defaults to document), wires a
// `change` listener that reveals only the row matching the chosen polling
// method (snmp/ssh/winrm), hides the others (and hides all three on
// rest_api / icmp / disabled), and applies the same logic to each
// dropdown's current value so the initial render lands in the right state
// before any user interaction. Idempotent against re-call — the wired flag
// on each element prevents stacking duplicate listeners.
function _wireStreamCredentialPickerVisibility(rootEl) {
  var root = rootEl || document;
  var selects = root.querySelectorAll("select[data-poll-source][data-poll-stream]");
  function applyOne(sel) {
    var pollId = sel.id;
    if (!pollId) return;
    var value = sel.value || "";
    ["snmp", "ssh", "winrm"].forEach(function (credType) {
      var row = document.getElementById(pollId + "-credrow-" + credType);
      if (!row) return;
      row.style.display = (value === credType) ? "" : "none";
    });
  }
  for (var i = 0; i < selects.length; i++) {
    var sel = selects[i];
    applyOne(sel);
    if (!sel.dataset.polarisCredRowsWired) {
      sel.dataset.polarisCredRowsWired = "1";
      sel.addEventListener("change", (function (s) {
        return function () { applyOne(s); };
      })(sel));
    }
  }
}

// Wires every nested tab strip rendered inside the Monitoring tab: one
// class-level strip (intg-mon-class) plus one stream-level strip per class
// subtab (intg-mon-streams-primary + intg-mon-streams-<klass> for each
// secondary class). Idempotent — safe to call whenever the modal mounts.
// Bind the Enable/Disable Auto-Monitoring button to its paired hidden
// checkbox. The button toggles the checkbox, dispatches a `change` event
// (so the existing automon-wrap visibility listener and any other change
// hooks fire unchanged), and re-themes itself (blue → red on enable,
// red → blue on disable). Idempotent: re-binding is harmless.
function _wireAutoMonitoringButtons(rootEl) {
  var root = rootEl || document;
  var buttons = root.querySelectorAll('button[data-auto-monitor-toggle]');
  for (var i = 0; i < buttons.length; i++) {
    var btn = buttons[i];
    if (btn.dataset.wired === "1") continue;
    btn.dataset.wired = "1";
    (function (b) {
      b.addEventListener("click", function () {
        var targetId = b.getAttribute("data-auto-monitor-toggle");
        var hidden = document.getElementById(targetId);
        if (!hidden) return;
        var nextOn = !hidden.checked;
        hidden.checked = nextOn;
        if (nextOn) {
          b.classList.remove("btn-primary");
          b.classList.add("btn-danger");
          b.textContent = "Disable Auto-Monitoring";
        } else {
          b.classList.remove("btn-danger");
          b.classList.add("btn-primary");
          b.textContent = "Enable Auto-Monitoring";
        }
        // Dispatch so the existing change listener (automon-wrap display,
        // any future side effects) fires as before. Inputs of type=checkbox
        // dispatch 'change' on user interaction; we have to do it manually
        // when we mutate `checked` from JS.
        hidden.dispatchEvent(new Event("change", { bubbles: true }));
      });
    })(btn);
  }
}

function _wireMonitoringTabSubtabs(integrationType) {
  var spec = _CLASS_SUBTAB_SPECS[integrationType];
  if (!spec) return;
  wireModalTabs("intg-mon-class");
  // Wire the Enable/Disable Auto-Monitoring buttons for every class subtab.
  _wireAutoMonitoringButtons(document);

  // Lock REST API on every stream that cannot make a FortiOS call, and reveal
  // the note that says why. Applied once now for the initial render, and again
  // whenever either input that decides it changes: the transport toggle
  // (handled with the relabel below) and the FortiGate API Token field, since
  // typing a token unlocks REST without touching the transport.
  _applyFortiosRestLocks(document, integrationType);
  var tokenEl = document.getElementById("f-fortigateApiToken");
  if (tokenEl && tokenEl.dataset.polarisRestLockWired !== "1") {
    tokenEl.dataset.polarisRestLockWired = "1";
    tokenEl.addEventListener("input", function () {
      _applyFortiosRestLocks(document, integrationType);
      var directEl = document.getElementById("f-useDirect");
      _relabelInheritOptions(document, !!(directEl && directEl.checked));
    });
  }
  spec.classes.forEach(function (c) {
    var prefix = (c.key === spec.primary)
      ? "intg-mon-streams-primary"
      : "intg-mon-streams-" + c.key;
    wireModalTabs(prefix);

    // Wire the Direct Polling toggle (if any) for this class so flipping it
    // reveals or hides the per-stream subtab wrapper without losing the
    // values inside. Classes without a toggle (standalone FortiGate's
    // FortiGate subtab, AD / Entra / WinSrv) render the wrapper always-on
    // and don't enter this branch.
    var toggleId = _directPollingToggleIdFor(integrationType, c.key);
    if (toggleId) {
      var streamsWrapId = "intg-mon-streams-wrap-" + (c.key === spec.primary ? "primary-" : "") + c.key;
      var toggleEl = document.getElementById(toggleId);
      var wrapEl   = document.getElementById(streamsWrapId);
      if (toggleEl && wrapEl) {
        // Closure captures the per-class toggle + wrap; outer scope captures
        // integrationType so the FMG-only "FortiGate Direct" vs "FortiManager
        // Proxy" relabel only fires for fortimanager integrations.
        (function (tEl, wEl, cls) {
          tEl.addEventListener("change", function () {
            // The FMG-FortiGate class no longer hides its streams behind the
            // transport toggle — see the note in the class-subtab renderer.
            // Its dropdowns are locked individually instead, so leave the
            // wrapper visible and just re-evaluate the locks below.
            var isFmgFortigateClass = cls === "fortigate" && integrationType === "fortimanager";
            if (!isFmgFortigateClass) wEl.style.display = tEl.checked ? "" : "none";
            // FMG's f-useDirect toggle changes the source label across every
            // stream-subtab dropdown in the whole modal (every class subtab
            // reads "FortiGate Direct" vs "FortiManager Proxy" from the same
            // toggle). Relabel everything inside the Monitoring tab; the
            // class-specific FortiSwitch / FortiAP toggles don't change any
            // labels so they skip this branch.
            if (cls === "fortigate" && integrationType === "fortimanager") {
              var monTab = document.getElementById("intg-mon-class-tabs") || document;
              // The class subtabs may have moved out of the tab-strip wrapper
              // depending on the modal HTML; fall back to walking from the
              // form root so every dropdown gets relabeled.
              var root = monTab.closest ? (monTab.closest("form, .modal, body") || document) : document;
              _relabelInheritOptions(root, tEl.checked);
              // Flipping the transport changes whether a FortiOS call is
              // possible, so the locks and the explanatory note move with it.
              _applyFortiosRestLocks(root, integrationType);
            }
          });
        })(toggleEl, wrapEl, c.key);
      }
    }

    // FMG/FortiGate only: gate the Auto-Monitor Interfaces section on the
    // class's addAsMonitored checkbox. Auto-monitor pins fast-cadence
    // interfaces on newly-discovered assets, so it only makes sense when
    // those assets are actually being added as monitored. Each class
    // (fortigate / fortiswitch / fortiap) has its own checkbox + its own
    // wrapper id; classes without one (AD / Entra / WinSrv) skip this.
    var addAsMonitoredId = null;
    var automonPrefix = null; // DOM id prefix for this class's addAsMonitored + automon-wrap
    if (integrationType === "fortimanager" || integrationType === "fortigate") {
      if (c.key === "fortigate"   || c.key === "fortiswitch" || c.key === "fortiap") {
        automonPrefix = "f-mon-" + c.key + "-";
      }
    } else if (_isWsSrvRichType(integrationType)) {
      // Spec keys are plural (workstations / servers); DOM ids use singular.
      if (c.key === "workstations") automonPrefix = "f-mon-workstation-";
      else if (c.key === "servers") automonPrefix = "f-mon-server-";
    }
    if (automonPrefix) addAsMonitoredId = automonPrefix + "addAsMonitored";
    if (addAsMonitoredId) {
      var automonWrapId = automonPrefix + "automon-wrap";
      var addEl = document.getElementById(addAsMonitoredId);
      var automonWrapEl = document.getElementById(automonWrapId);
      if (addEl && automonWrapEl) {
        (function (a, w) {
          a.addEventListener("change", function () { w.style.display = a.checked ? "" : "none"; });
        })(addEl, automonWrapEl);
      }
    }
  });
  // Reactive per-stream credential rows (snmp/ssh/winrm) reveal based on the
  // polling-method dropdown's chosen value. Scoped to the Monitoring tab so
  // we don't touch dropdowns on other tabs. The Direct Polling toggle (above)
  // hides the entire stream subtab strip but doesn't unmount it — credrow
  // wiring stays valid when the wrapper flips back on.
  var monRoot = document.getElementById("intg-mon-class-tabs");
  if (monRoot && monRoot.closest) {
    monRoot = monRoot.closest("form, .modal-body, .modal, body") || document;
  }
  _wireStreamCredentialPickerVisibility(monRoot || document);
}

// Wires the per-asset-timeout warning indicator so the Cadence section
// surfaces "⚠ Below 500 ms" feedback while the operator types. Mirrors the
// same warning the assets-page Monitoring Settings modal renders.
function _wireProbeTimeoutWarning() {
  var input = document.getElementById("f-mon-probeTimeoutMs");
  var warn  = document.getElementById("f-mon-probeTimeoutMs-warn");
  if (!input || !warn) return;
  function check() {
    var v = parseInt(input.value, 10);
    warn.style.display = (Number.isFinite(v) && v > 0 && v < 500) ? "inline" : "none";
  }
  input.addEventListener("input", check);
  check();
}

// Reactive show/hide of the Discovery Defaults credential rows on the
// FortiGates / FortiSwitches / FortiAPs subtabs. The SNMP rows appear iff
// any of the four integration-tier polling dropdowns is set to SNMP; the
// SSH rows appear iff any is set to SSH. Run on initial render and on every
// dropdown change so the UI reflects the live selection without a save.
function _syncCredentialPickerVisibility() {
  var streamDefs = [
    { pollId: "f-mon-tier-responseTimePolling", mibWrapId: "f-mon-tier-responseTime-mib-wrap" },
    { pollId: "f-mon-tier-cpuMemoryPolling",    mibWrapId: "f-mon-tier-telemetry-mib-wrap"    },
    { pollId: "f-mon-tier-temperaturePolling",  mibWrapId: "f-mon-tier-temperature-mib-wrap"  },
    { pollId: "f-mon-tier-interfacesPolling",   mibWrapId: "f-mon-tier-interfaces-mib-wrap"   },
    { pollId: "f-mon-tier-lldpPolling",         mibWrapId: "f-mon-tier-lldp-mib-wrap"         },
    // Storage has no per-stream MIB picker (HOST-RESOURCES-MIB + vendor
    // fallback; nothing for the operator to choose), so mibWrapId is null.
    { pollId: "f-mon-tier-storagePolling",      mibWrapId: null                                },
  ];
  var anySnmp = false, anySsh = false;
  for (var i = 0; i < streamDefs.length; i++) {
    var el = document.getElementById(streamDefs[i].pollId);
    if (!el) continue;
    if (el.value === "snmp") anySnmp = true;
    if (el.value === "ssh")  anySsh  = true;
    // Show/hide the per-stream MIB sub-row for this stream. mibWrapId is null
    // for streams that don't carry a MIB picker (storage). Reveal as "" so the
    // form-group resumes its default block layout — using "flex" puts the
    // label, select, and hint paragraph on a single horizontal line which is
    // wrong for the per-class stream subtab's stacked layout.
    if (streamDefs[i].mibWrapId) {
      var mibWrap = document.getElementById(streamDefs[i].mibWrapId);
      if (mibWrap) mibWrap.style.display = (el.value === "snmp") ? "" : "none";
    }
  }
  var snmpRowIds = ["f-mon-credential-row", "f-mon-fortiswitch-credentialId-row", "f-mon-fortiap-credentialId-row"];
  var sshRowIds  = ["f-mon-credential-ssh-row", "f-mon-fortiswitch-sshCredentialId-row", "f-mon-fortiap-sshCredentialId-row"];
  function toggle(idList, show) {
    for (var j = 0; j < idList.length; j++) {
      var row = document.getElementById(idList[j]);
      if (row) row.style.display = show ? "" : "none";
    }
  }
  toggle(snmpRowIds, anySnmp);
  toggle(sshRowIds,  anySsh);
}

// Wires `change` listeners on the four integration-tier polling dropdowns so
// _syncCredentialPickerVisibility() runs whenever the operator picks a new
// method. Also runs once on initial mount so a freshly-opened modal lands in
// the correct state.
function _wireCredentialPickerVisibility() {
  var ids = ["f-mon-tier-responseTimePolling", "f-mon-tier-cpuMemoryPolling", "f-mon-tier-temperaturePolling", "f-mon-tier-interfacesPolling", "f-mon-tier-lldpPolling", "f-mon-tier-storagePolling"];
  var any = false;
  for (var i = 0; i < ids.length; i++) {
    var el = document.getElementById(ids[i]);
    if (!el) continue;
    el.addEventListener("change", _syncCredentialPickerVisibility);
    any = true;
  }
  if (any) _syncCredentialPickerVisibility();
}

// Call after monitorSettingsFormHTML() has been inserted into the DOM. Wires
// each subtab's auto-monitor card. Safe to call when integrationId is null
// (Create modal) — the cards still render but the live preview + aggregate
// list are suppressed inside the wiring helper.
function wireAutoMonitorCards(integrationId) {
  _wireAutoMonitorCard("f-mon-fortigate-amon-",   "fortigate",   integrationId || null);
  _wireAutoMonitorCard("f-mon-fortiswitch-amon-", "fortiswitch", integrationId || null);
  _wireAutoMonitorCard("f-mon-fortiap-amon-",     "fortiap",     integrationId || null);
}

// AD/Entra analog: wire the Workstations + Servers subtab cards (interface
// auto-monitor reused with hideLldp, storage auto-monitor, agent auto-deploy).
// Safe to call with null integrationId (Create modal) — previews/aggregates are
// suppressed inside the wiring helpers. The interface cards use the shared
// _wireAutoMonitorCard with the workstation/server class param so the aggregate
// + preview endpoints dispatch on assetType.
function wireWorkstationServerCards(integrationId) {
  _wireAutoMonitorCard("f-mon-workstation-amon-", "workstation", integrationId || null);
  _wireAutoMonitorCard("f-mon-server-amon-",      "server",      integrationId || null);
  _wireAutoMonitorStorageCard("f-mon-workstation-stor-", "workstation", integrationId || null);
  _wireAutoMonitorStorageCard("f-mon-server-stor-",      "server",      integrationId || null);
}

// vCenter analog: the Virtual Machines subtab carries the same interface +
// storage auto-monitor cards (agent-fed); ESXi hosts carry none.
function wireVcenterCards(integrationId) {
  _wireAutoMonitorCard("f-mon-vm-amon-",     "virtual_machine", integrationId || null);
  _wireAutoMonitorStorageCard("f-mon-vm-stor-", "virtual_machine", integrationId || null);
}

// Reads the eight integration-tier cadence + retention fields from the
// Monitoring tab. Returns the flat MonitorTierSettings shape that the
// `/api/v1/monitor-settings/integration/:id` endpoint accepts. Out-of-range
// or empty values are dropped (server-side Zod re-validates anyway).
function _readIntegrationCadenceForm() {
  function n(name) {
    var el = document.getElementById("f-mon-" + name);
    if (!el) return undefined;
    var v = parseInt(el.value, 10);
    return Number.isFinite(v) ? v : undefined;
  }
  // systemInfoIntervalSeconds accepts a blank input meaning "follow the
  // integration's discovery pollInterval". Blank → null (not undefined) so
  // the server-side Zod (nullable on the integration tier) accepts it and
  // the resolver applies the pollInterval derivation.
  function nNullable(name) {
    var el = document.getElementById("f-mon-" + name);
    if (!el) return undefined;
    var raw = (el.value == null ? "" : String(el.value)).trim();
    if (raw === "") return null;
    var v = parseInt(raw, 10);
    return Number.isFinite(v) ? v : null;
  }
  var out = {
    intervalSeconds:           n("intervalSeconds"),
    probeTimeoutMs:            n("probeTimeoutMs"),
    cpuMemoryTimeoutMs:        n("cpuMemoryTimeoutMs"),
    temperatureTimeoutMs:      n("temperatureTimeoutMs"),
    systemInfoTimeoutMs:       n("systemInfoTimeoutMs"),
    cpuMemoryIntervalSeconds:  n("cpuMemoryIntervalSeconds"),
    temperatureIntervalSeconds: n("temperatureIntervalSeconds"),
    systemInfoIntervalSeconds: nNullable("systemInfoIntervalSeconds"),
    // Phase 1 carves LLDP + Storage out of systemInfo cadence: the inputs are
    // rendered + persisted, but the backend resolver still has them riding
    // systemInfoIntervalSeconds at runtime. Phase 2 lands the actual queue
    // split. Storing today keeps operator intent across the cutover.
    lldpIntervalSeconds:       n("lldpIntervalSeconds"),
    lldpTimeoutMs:             n("lldpTimeoutMs"),
    storageIntervalSeconds:    n("storageIntervalSeconds"),
    storageTimeoutMs:          n("storageTimeoutMs"),
  };
  // Slice 2 split telemetry into cpuMemory + temperature streams server-side
  // (TierSettingsSchema requires both). The Temperature inputs are now in
  // the form, but when the operator leaves them blank we mirror the cpuMemory
  // values so the save still satisfies the required-both shape.
  if (out.temperatureIntervalSeconds === undefined) {
    out.temperatureIntervalSeconds = out.cpuMemoryIntervalSeconds;
  }
  if (out.temperatureTimeoutMs === undefined) {
    out.temperatureTimeoutMs = out.cpuMemoryTimeoutMs;
  }
  Object.assign(out, _polarisReadPollingFourStream("f-mon-tier-"));
  Object.assign(out, _polarisReadMibFourStream("f-mon-tier-"));
  return out;
}

// Kept under the old name for the two existing call sites in the Add/Edit
// flows — both pass the result straight into setIntegration(). Identical
// shape, just renamed for clarity.
function getMonitorSettingsFromForm() {
  return _readIntegrationCadenceForm();
}

// Phase 2 — read the per-stream values from one class subtab into the
// `streams` shape the backend persists at config.<klass>Monitor.streams.
// `isPrimary` true reads from the primary subtab's legacy IDs
// (`f-mon-tier-<pollField>` / `f-mon-<intervalField>`); false reads from
// the secondary subtab's namespaced IDs
// (`f-mon-classecho-<klass>-tier-<pollField>` / `f-mon-classecho-<klass>-<intervalField>`).
// `includeStorage` matches `_streamsForClass` — FortiAP omits storage.
function _readClassStreamSubtabs(klass, isPrimary, includeStorage) {
  function id(suffix) {
    return isPrimary ? ("f-mon-" + suffix) : ("f-mon-classecho-" + klass + "-" + suffix);
  }
  function tierId(suffix) {
    return isPrimary ? ("f-mon-tier-" + suffix) : ("f-mon-classecho-" + klass + "-tier-" + suffix);
  }
  function pollVal(field) {
    var el = document.getElementById(tierId(field));
    if (!el) return undefined;
    var v = el.value || "";
    return v.length > 0 ? v : null;
  }
  function mibVal(streamKey) {
    var el = document.getElementById(tierId(streamKey + "Mib"));
    if (!el) return undefined;
    var v = el.value || "";
    return v.length > 0 ? v : null;
  }
  function numVal(field) {
    var el = document.getElementById(id(field));
    if (!el) return undefined;
    var raw = (el.value == null ? "" : String(el.value)).trim();
    if (raw === "") return null;
    var n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  }
  // Reads the per-stream credential dropdown that matches the chosen polling
  // method. _classStreamSubtabHTML emits three sibling dropdowns per stream
  // (snmp/ssh/winrm/http), and only the one matching `polling` is visible to
  // the operator — the others stay at "Inherit / none". When the class subtab
  // omitted per-stream credentials entirely (FortiSwitch + FortiAP via
  // showStreamCredentials: false), the lookup misses every credtype dropdown
  // and we return undefined so the streams cell stays free of a credentialId
  // key, letting the resolver fall back to the asset's monitorCredentialId
  // which discovery already stamps from the class-level credential picker.
  function credVal(pollField) {
    var pollEl = document.getElementById(tierId(pollField));
    if (!pollEl) return undefined;
    var method = pollEl.value || "";
    var credType = method === "snmp" ? "snmp"
      : method === "ssh"   ? "ssh"
      : method === "winrm" ? "winrm"
      : null;
    if (!credType) return null;
    var credEl = document.getElementById(tierId(pollField) + "-cred-" + credType);
    if (!credEl) return undefined; // row not rendered (showStreamCredentials=false)
    return credEl.value || null;
  }
  // Cell builder for one stream. Empty per-stream cells are still serialized
  // as `{polling:null, intervalSeconds:null, ...}` so the operator's explicit
  // "inherit at all 4 layers" choice persists across reload.
  function cell(opts) {
    var out = {};
    if (opts.polling          !== undefined) out.polling          = opts.polling;
    if (opts.credentialId     !== undefined) out.credentialId     = opts.credentialId;
    if (opts.intervalSeconds  !== undefined) out.intervalSeconds  = opts.intervalSeconds;
    if (opts.timeoutMs        !== undefined) out.timeoutMs        = opts.timeoutMs;
    if (opts.mibId            !== undefined) out.mibId            = opts.mibId;
    return out;
  }
  var streams = {
    responseTime: cell({
      polling:          pollVal("responseTimePolling"),
      credentialId:     credVal("responseTimePolling"),
      intervalSeconds:  numVal("intervalSeconds"),
      timeoutMs:        numVal("probeTimeoutMs"),
      mibId:            mibVal("responseTime"),
    }),
    cpuMemory: cell({
      polling:         pollVal("cpuMemoryPolling"),
      credentialId:    credVal("cpuMemoryPolling"),
      intervalSeconds: numVal("cpuMemoryIntervalSeconds"),
      timeoutMs:       numVal("cpuMemoryTimeoutMs"),
      mibId:           mibVal("cpuMemory"),
    }),
    temperature: cell({
      polling:         pollVal("temperaturePolling"),
      credentialId:    credVal("temperaturePolling"),
      intervalSeconds: numVal("temperatureIntervalSeconds"),
      timeoutMs:       numVal("temperatureTimeoutMs"),
      mibId:           mibVal("temperature"),
    }),
    interfaces: cell({
      polling:         pollVal("interfacesPolling"),
      credentialId:    credVal("interfacesPolling"),
      intervalSeconds: numVal("systemInfoIntervalSeconds"),
      timeoutMs:       numVal("systemInfoTimeoutMs"),
      mibId:           mibVal("interfaces"),
    }),
    lldp: cell({
      polling:         pollVal("lldpPolling"),
      credentialId:    credVal("lldpPolling"),
      intervalSeconds: numVal("lldpIntervalSeconds"),
      timeoutMs:       numVal("lldpTimeoutMs"),
      mibId:           mibVal("lldp"),
    }),
  };
  if (includeStorage !== false) {
    streams.storage = cell({
      polling:         pollVal("storagePolling"),
      credentialId:    credVal("storagePolling"),
      intervalSeconds: numVal("storageIntervalSeconds"),
      timeoutMs:       numVal("storageTimeoutMs"),
    });
  }
  // Cross-transport streams — only serialized for classes that render them
  // (see _streamsForClass): workstation/server get both, fortigate gets
  // eventLog only, appliances get neither. Reading absent inputs would return
  // all-undefined and emit an empty {} cell, so gate on applicability.
  var applicable = {};
  _streamsForClass(klass).forEach(function (s) { applicable[s.key] = true; });
  if (applicable.processes) {
    streams.processes = cell({
      polling:         pollVal("processesPolling"),
      credentialId:    credVal("processesPolling"),
      intervalSeconds: numVal("processesIntervalSeconds"),
      timeoutMs:       numVal("processesTimeoutMs"),
      mibId:           mibVal("processes"),
    });
  }
  if (applicable.eventLog) {
    streams.eventLog = cell({
      polling:         pollVal("eventLogPolling"),
      credentialId:    credVal("eventLogPolling"),
      intervalSeconds: numVal("eventLogIntervalSeconds"),
      timeoutMs:       numVal("eventLogTimeoutMs"),
    });
  }
  return streams;
}

// Reads the "enable direct polling" + SNMP/SSH credential pickers + the
// auto-Monitor flag + the auto-monitor-interfaces selection for one class
// (FortiSwitch or FortiAP). Returns null when the subtab didn't render.
// Both credential ids are persisted regardless of which row is currently
// visible — flipping the integration tier between SNMP and SSH should
// restore the prior selection rather than zero it out.
function _readClassMonitorBlock(prefix, opts) {
  var enabledEl    = document.getElementById(prefix + "enabled");
  var credEl       = document.getElementById(prefix + "credentialId");
  var sshCredEl    = document.getElementById(prefix + "sshCredentialId");
  var addMonEl     = document.getElementById(prefix + "addAsMonitored");
  if (!enabledEl || !credEl) return null;
  var ami = _readAutoMonitorInterfaces(prefix + "amon-");
  var out = {
    enabled: enabledEl.checked === true,
    snmpCredentialId: credEl.value || null,
    sshCredentialId:  sshCredEl ? (sshCredEl.value || null) : null,
    addAsMonitored: addMonEl ? addMonEl.checked === true : false,
    autoMonitorInterfaces: ami === undefined ? null : ami,
  };
  // Phase 2 per-class streams. `opts.klass` and `opts.isPrimary` drive the
  // ID lookup for the stream subtabs inside this class subtab. FortiAP omits
  // storage. When the caller doesn't pass these (legacy invocation), we skip
  // the streams field so backward-compat behavior is preserved.
  if (opts && opts.klass) {
    out.streams = _readClassStreamSubtabs(opts.klass, opts.isPrimary === true, opts.includeStorage !== false);
  }
  return out;
}

// FortiGate variant — only the auto-Monitor flag (no direct-polling toggle
// since FortiGates always have the integration source link stamped at
// discovery, which the resolver picks REST API for) plus the
// auto-monitor-interfaces selection.
function _readFortigateMonitorBlock(prefix, opts) {
  var addMonEl   = document.getElementById(prefix + "addAsMonitored");
  var pullEl     = document.getElementById(prefix + "pullSnmpLocation");
  var pushEl     = document.getElementById(prefix + "pushGeocodedCoords");
  var latEl      = document.getElementById(prefix + "latitudeMetavar");
  var lngEl      = document.getElementById(prefix + "longitudeMetavar");
  var addrEl     = document.getElementById(prefix + "addressMetavar");
  if (!addMonEl) return null;
  var ami = _readAutoMonitorInterfaces(prefix + "amon-");
  var useEl = document.getElementById(prefix + "useSnmpLocationCoords");
  var addrVal = addrEl ? addrEl.value.trim() : "";
  var pullOn = pullEl ? pullEl.checked === true : false;
  // sysLocation-derived coords require the pull (nothing to geocode without
  // it); push is allowed when there's an ACTIVE geocode source — sysLocation
  // coords enabled, or a named address metavar. Force both false otherwise
  // (the checkboxes are disabled in those states). Metavar-name inputs are
  // FMG-only — absent on standalone FortiGate, where they fall back to the
  // defaults (ignored by that path).
  var useCoords = pullOn && useEl ? useEl.checked === true : false;
  var pushAllowed = useCoords || addrVal !== "";
  var out = {
    addAsMonitored: addMonEl.checked === true,
    autoMonitorInterfaces: ami === undefined ? null : ami,
    pullSnmpLocation: pullOn,
    useSnmpLocationCoords: useCoords,
    pushGeocodedCoords: (pushAllowed && pushEl) ? pushEl.checked === true : false,
    latitudeMetavar: (latEl && latEl.value.trim()) || "Latitude",
    longitudeMetavar: (lngEl && lngEl.value.trim()) || "Longitude",
    addressMetavar: addrVal,
  };
  // Phase 2: FortiGate subtab is the primary class subtab for FMG / standalone
  // FortiGate integrations. Read its per-stream values into config.fortigateMonitor.streams.
  if (opts && opts.klass) {
    out.streams = _readClassStreamSubtabs(opts.klass, opts.isPrimary === true, true);
  }
  return out;
}

// AD / Entra / Windows Server Workstations + Servers reader. No enabled
// toggle (those integrations always discover); no per-class snmp/ssh
// credentials (per-stream credentials inside `streams` carry that). The
// addAsMonitored flag is persisted but not yet consulted by AD/Entra/WinSrv
// discovery code — a backend follow-up will wire it. Auto-Monitor
// Interfaces is omitted by design (workstation/server endpoints don't have
// an authoritative interface roster to apply against).
function _readWorkstationServerMonitorBlock(prefix, opts) {
  var addMonEl = document.getElementById(prefix + "addAsMonitored");
  if (!addMonEl) return null;
  // Interface + storage auto-monitor selections and the agent-deploy block.
  // Each reader returns undefined when its card never rendered (e.g. the
  // WindowsServer path or a subtab the operator never opened) — coalesce to
  // null so the saved block carries an explicit "off" rather than dropping a
  // previously-stored value silently.
  var ami = _readAutoMonitorInterfaces(prefix + "amon-");
  var ams = _readAutoMonitorStorage(prefix + "stor-");
  var dep = _readAgentDeploy(prefix + "deploy-");
  var out = {
    addAsMonitored: addMonEl.checked === true,
    autoMonitorInterfaces: (ami === undefined ? null : ami),
    autoMonitorStorage:    (ams === undefined ? null : ams),
    agentDeploy:           (dep === undefined ? null : dep),
  };
  if (opts && opts.klass) {
    out.streams = _readClassStreamSubtabs(opts.klass, opts.isPrimary === true, true);
  }
  return out;
}

