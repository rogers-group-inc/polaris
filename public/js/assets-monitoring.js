/**
 * public/js/assets-monitoring.js — the Monitoring tab: the per-stream source badges and polling
 * intervals, Discover now, the monitoring view, the intermittency bar,
 * response-time history and the monitor chart.
 *
 * Part of the Assets page script (CQ-F050): plain browser scripts sharing
 * page globals, loaded right after assets.js on every page that carries it
 * and in app-panels.js's asset bundle, in ASSETS_FILES order. Nothing here
 * runs at load beyond listener wiring. See tests/unit/assetsSplit.test.ts.
 */

// Per-stream polling-method + asset-source resolver used by the chart badges
// in the asset System tab. Each chart shows what protocol is actually moving
// data on its stream and which integration the asset came from. Reads the
// per-asset *Polling override first and falls back to the source default.
// Returns
//   { polling: "REST API" | "SNMP · <cred>" | "WinRM" | "SSH" | "ICMP" | null,
//     source:  "FortiManager · <name>" | "Active Directory · <name>" | "Manual" | ... }
// `polling` is null when the source doesn't deliver that stream (e.g. AD/
// Entra/WinServer hosts have no telemetry/interfaces/lldp stream by
// default); the caller should hide the badge in that case.
// Append the parent FortiGate name when the asset is a managed
// FortiSwitch or FortiAP under an FMG/FortiGate integration. The chain
// "FortiManager · <fmg> → <FortiGate>" tells the operator which
// controller actually answers polls for this device. Returns the bare
// integration name otherwise. `joiner` controls the prefix between the
// integration label and integration name (": " for the Source detail row,
// " · " for the chart-badge style).
function _assetIntegrationLabelWithController(asset, joiner) {
  var integration = asset && asset.discoveredByIntegration;
  if (!integration) return "Manual";
  var typeLabels = {
    fortimanager:    "FortiManager",
    fortigate:       "FortiGate",
    activedirectory: "Active Directory",
    entraid:         "Entra ID",
    windowsserver:   "Windows Server",
    vcenter:         "vCenter",
    azurearc:        "Azure Arc",
    unraid:          "Unraid",
    truenas:         "TrueNAS SCALE",
    proxmox:         "Proxmox VE",
    genericapi:      "Generic API",
  };
  var label = (typeLabels[integration.type] || integration.type) + joiner + integration.name;
  if (asset.assetType !== "switch" && asset.assetType !== "access_point") return label;
  if (integration.type !== "fortimanager" && integration.type !== "fortigate") return label;
  var controller = asset.fortinetTopology && asset.fortinetTopology.controllerFortigate;
  if (!controller) return label;
  // Standalone FortiGate integrations: integration.name IS the controller —
  // suppress the redundant "→ same-name" suffix.
  if (typeof controller === "string" && controller.toLowerCase() === String(integration.name || "").toLowerCase()) {
    return label;
  }
  return label + " → " + controller;
}

// Stream name → Asset/resolver field prefix. Four of the five streams
// (responseTime / temperature / interfaces / lldp) use their stream name as
// the prefix directly; "telemetry" is the odd one out — its persisted
// columns are `cpuMemoryPolling` / `cpuMemoryCredential`
// / `cpuMemoryCredentialId` (the System-tab section is
// "CPU & Memory" — "telemetry" is the UI/cadence-bucket label, not a column
// prefix). Every lookup that does `stream + "Polling"` etc. routes through
// this helper so the telemetry badge picks up class-override / per-asset
// values instead of silently falling back to the source default.
function _streamFieldPrefix(stream) {
  return stream === "telemetry" ? "cpuMemory" : stream;
}

function _assetMonitorStreamSource(asset, stream) {
  if (!asset) return { polling: null, source: "—" };
  var integration = asset.discoveredByIntegration;

  // Asset source: which integration discovered this asset (with the parent
  // FortiGate appended for managed switches/APs), or "Manual".
  var sourceName = _assetIntegrationLabelWithController(asset, " · ");

  // Per-asset polling override wins; otherwise show the source default for
  // this stream. This is a coarse view (skips class-override / tier-3 layers
  // — that fidelity comes from /effective-monitor-settings) and is good
  // enough for the at-a-glance chart badge.
  var sourceKind = (integration && integration.type) || "manual";
  if (!_POLLING_COMPAT[sourceKind]) sourceKind = "manual";
  var assetField = _streamFieldPrefix(stream) + "Polling";
  var resolved = asset[assetField] || _polarisSourceDefaultPolling(sourceKind, stream);
  if (!resolved) return { polling: null, source: sourceName };

  var polling = _POLLING_LABELS[resolved] || resolved;
  // Append the credential name on transports that need one — gives the
  // operator a quick visual confirmation of which credential the probe is
  // about to use without opening the edit modal.
  var cred = asset.monitorCredential;
  if ((resolved === "snmp" || resolved === "winrm" || resolved === "ssh" || resolved === "rest_api") && cred && cred.name) {
    polling += " · " + cred.name;
  }
  return { polling: polling, source: sourceName };
}

// Tier labels for the four-tier hierarchy. Provenance values
// ("asset"|"class"|"integration"|"manual"|"default") come from
// /effective-monitor-settings. The badge tells the operator where to go to
// change the value; "default" means no tier set a compatible method and the
// runtime source default applies (2026-08 resolver fold — the badges now
// always describe what the monitor runtime actually does).
var _TIER_LABELS = {
  asset:       "Asset override",
  class:       "Class override",
  integration: "Integration",
  manual:      "Manual",
  default:     "Source default",
};

// Transport descriptor for a resolved polling method. Returns the inner
// text (caller wraps in parens). Empty when transport is unambiguous —
// SNMP/ICMP/WinRM/SSH always go directly to the asset's IP, and standalone
// FortiGate REST API has no transport to choose. Returns:
//   "Proxy via <fmg>" / "Direct"   for FMG REST API at the FortiGate
//   "via parent FortiGate"         for managed FortiSwitch/FortiAP REST API
//                                  (probe queries the parent FortiGate's
//                                  controller-status table, not the
//                                  device's own IP).
function _streamTransportLabel(asset, resolvedPolling) {
  if (resolvedPolling !== "rest_api") return "";
  var integ = asset && asset.discoveredByIntegration;
  if (!integ) return "";
  if ((asset.assetType === "switch" || asset.assetType === "access_point") &&
      (integ.type === "fortimanager" || integ.type === "fortigate")) {
    return "via parent FortiGate";
  }
  if (integ.type === "fortimanager") {
    if (integ.useProxy === true)  return "Proxy via " + integ.name;
    if (integ.useProxy === false) return "Direct";
  }
  return "";
}

// Resolves which credential is actually used to authenticate this stream's
// probe so the badge can name it. Resolution mirrors the dispatcher in
// monitoringService.probeAsset: per-stream credential → legacy generic
// monitorCredential → integration's stored credential (SNMP/WinRM/SSH on
// FMG/FortiGate-discovered assets only — REST API on those uses the
// integration's API token, which isn't a Credential row and stays implicit
// in the "Proxy via …" / "Direct" transport label). ICMP doesn't
// authenticate.
function _streamCredential(asset, stream, resolvedPolling, effectiveResolved) {
  if (!asset || resolvedPolling === "icmp" || resolvedPolling === "disabled") return null;
  // Storage has no credential of its own: the server resolves it from the
  // Interfaces stream's (CLASS_STREAM_FIELD_MAP.storage in monitorSettings.ts).
  var prefix = stream === "storage" ? "interfaces" : _streamFieldPrefix(stream);
  var perStream = asset[prefix + "Credential"];
  if (perStream && perStream.name) return perStream;
  if (asset.monitorCredential && asset.monitorCredential.name) return asset.monitorCredential;
  // Class-override per-stream credential — only available when the caller
  // passed eff.resolved from /effective-monitor-settings. Look the
  // credential up by id in the credential cache so the badge labels match
  // what the probe actually uses after the resolver fix.
  if (effectiveResolved) {
    var credId = effectiveResolved[prefix + "CredentialId"];
    if (credId && _credentialCache && Array.isArray(_credentialCache.list)) {
      var found = _credentialCache.list.find(function (c) { return c.id === credId; });
      if (found && found.name) return found;
    }
  }
  if ((resolvedPolling === "snmp" || resolvedPolling === "winrm" || resolvedPolling === "ssh") &&
      asset.integrationMonitorCredential && asset.integrationMonitorCredential.name) {
    return asset.integrationMonitorCredential;
  }
  return null;
}

// Maps a stream name to the per-asset interval-override column. The
// per-asset tier exposes only three columns; interfaces/lldp share the
// system-info column since both ride the system-info pass.
function _streamIntervalAssetField(stream) {
  if (stream === "responseTime") return "monitorIntervalSec";
  // Hardware sensors (internal key "temperature") ride the telemetry cadence —
  // they're collected alongside CPU/memory in runTelemetryFor — so the badge
  // shows the telemetry interval as the true poll rate. (If an independent
  // hardware-sensor cadence ever lands, switch this to temperatureIntervalSec.)
  if (stream === "telemetry" || stream === "temperature") return "cpuMemoryIntervalSec";
  // "systemInfo" is the stale banner's name for the interfaces pass — it asks
  // for the cadence by stream, not by section.
  if (stream === "interfaces" || stream === "systemInfo") return "systemInfoIntervalSec";
  // LLDP and Storage run on their own queues (polaris-monitor-lldp /
  // polaris-monitor-storage) and cadences; they no longer ride system info.
  if (stream === "lldp") return "lldpIntervalSec";
  if (stream === "storage") return "storageIntervalSec";
  return null;
}

// Maps a stream name to the resolved-settings interval field returned by
// /effective-monitor-settings. interfaces/lldp share the system-info
// cadence — same rationale as the per-asset mapping above.
function _streamIntervalEffectiveField(stream) {
  if (stream === "responseTime") return "intervalSeconds";
  // Hardware sensors ride the telemetry cadence (see _streamIntervalAssetField).
  if (stream === "telemetry" || stream === "temperature") return "cpuMemoryIntervalSeconds";
  // "systemInfo" — see _streamIntervalAssetField.
  if (stream === "interfaces" || stream === "systemInfo") return "systemInfoIntervalSeconds";
  if (stream === "lldp") return "lldpIntervalSeconds";
  if (stream === "storage") return "storageIntervalSeconds";
  return null;
}

// Humane "every Ns / Nm / Nh" rendering for a polling interval. Returns ""
// when the input isn't a positive finite number so the caller can drop the
// slot from the badge entirely instead of rendering "every NaNs".
function _formatPollingInterval(seconds) {
  if (typeof seconds !== "number" || !isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 60) return seconds + "s";
  if (seconds % 3600 === 0) return (seconds / 3600) + "h";
  if (seconds % 60 === 0)   return (seconds / 60) + "m";
  return seconds + "s";
}

// Builds the badge label "<polling>[ (<details>)][ · every <interval>] · <tier>"
// used next to each chart header. <details> bundles the transport
// descriptor and the credential name together in one parenthetical,
// comma-separated. `provenanceTier` is one of asset|class|integration|
// manual; pass null to fall back to a coarse sync guess (per-asset field
// set → asset override; integration present → integration tier; otherwise
// → manual tier). The async path passes the real provenance.
// `intervalSeconds` is the resolved cadence for this stream (response-time
// /telemetry/system-info); pass null to omit the slot entirely.
function _streamBadgeText(asset, stream, resolvedRaw, provenanceTier, intervalSeconds, effectiveResolved) {
  var pollingLabel = _POLLING_LABELS[resolvedRaw] || resolvedRaw;
  var transport = _streamTransportLabel(asset, resolvedRaw);
  var credential = _streamCredential(asset, stream, resolvedRaw, effectiveResolved);
  var details = [];
  if (transport)  details.push(transport);
  if (credential) details.push(credential.name);
  var detailsStr = details.length ? " (" + details.join(", ") + ")" : "";
  var intervalLabel = _formatPollingInterval(intervalSeconds);
  var intervalStr = intervalLabel ? " · every " + intervalLabel : "";
  var tier;
  if (provenanceTier && _TIER_LABELS[provenanceTier]) {
    tier = _TIER_LABELS[provenanceTier];
  } else {
    var assetField = _streamFieldPrefix(stream) + "Polling";
    if (asset[assetField]) tier = _TIER_LABELS.asset;
    else if (asset.discoveredByIntegration) tier = _TIER_LABELS.integration;
    else tier = _TIER_LABELS.manual;
  }
  return pollingLabel + detailsStr + intervalStr + " · " + tier;
}

// Renders the badge content used next to each chart header. Returns ""
// when the stream isn't delivered for the asset's source kind (caller
// skips the badge entirely). The polling half + tier guess use a coarse
// local resolver at first render so the badge appears synchronously; the
// System tab open path fires _updateStreamSourceBadgesFromEffective()
// right after to overwrite it with the authoritative provenance from
// /effective-monitor-settings (covers class overrides + integration tier).
//
// `opts.intervalSec` (optional) states a cadence that is NOT the stream's own:
// SD-WAN borrows the Interfaces stream's method + tier (it is only scheduled
// when Interfaces is on FortiOS REST) but polls on the integration's
// sdwanIntervalSeconds, so its badge read "every 10m" over a 60s table. The
// figure rides the span as data-interval-sec so the async rewrite keeps it;
// null states "no cadence" and drops the "every" slot.
function _streamSourceBadgeHTML(asset, stream, opts) {
  var integration = asset.discoveredByIntegration;
  var sourceKind  = (integration && integration.type) || "manual";
  if (!_POLLING_COMPAT[sourceKind]) sourceKind = "manual";
  var assetField  = _streamFieldPrefix(stream) + "Polling";
  var resolvedRaw = asset[assetField] || _polarisSourceDefaultPolling(sourceKind, stream);
  if (!resolvedRaw) return "";
  var hasOverride = !!opts && Object.prototype.hasOwnProperty.call(opts, "intervalSec");
  // Interval for the sync render: the resolved figure when this asset's
  // /effective-monitor-settings has already been fetched, else the per-asset
  // override only. The async path overwrites badges that are in the DOM when
  // it lands — but a badge drawn AFTER it (the Wireless tab, which waits on the
  // system-info fetch, and every Poll re-render) is never rewritten, so without
  // the cache it showed no "every N" at all.
  var intervalAssetField = _streamIntervalAssetField(stream);
  var intervalEffField = _streamIntervalEffectiveField(stream);
  var effCached = _effectiveResolvedByAssetId.get(asset.id);
  var intervalSeconds = hasOverride
    ? (opts.intervalSec != null ? opts.intervalSec : null)
    : (effCached && intervalEffField && typeof effCached[intervalEffField] === "number")
      ? effCached[intervalEffField]
      : ((intervalAssetField && asset[intervalAssetField] != null) ? asset[intervalAssetField] : null);
  var label = _streamBadgeText(asset, stream, resolvedRaw, null, intervalSeconds);
  var titleLabel = "Polling method · Where this setting comes from";
  return '<span class="asset-stream-source-badge" data-asset-id="' + escapeHtml(asset.id) + '" data-stream="' + escapeHtml(stream) + '"' +
    (hasOverride ? ' data-interval-sec="' + escapeHtml(intervalSeconds != null ? String(intervalSeconds) : "") + '"' : "") +
    ' title="' + escapeHtml(titleLabel) + '" style="font-size:0.75rem;padding:2px 6px;border-radius:10px;background:var(--color-bg-primary);border:1px solid var(--color-border);color:var(--color-text-secondary);white-space:nowrap">' +
    escapeHtml(label) +
  '</span>';
}

// Fetches /effective-monitor-settings (which walks all four tiers) and
// rewrites each badge's text to reflect the truly-resolved polling method
// AND the actual tier that supplied it. Necessary because the sync render
// can't see class overrides or distinguish the integration tier from a
// source default — the badge would say "REST API · Integration" when the
// operator had set a class override to SNMP. Best-effort; on failure the
// badge keeps its sync value. Re-checks data-asset-id on each span so a
// stale fetch after the modal switched assets doesn't write into the
// wrong row.
// `effP` (optional) is a caller-supplied in-flight effective-monitor-settings
// promise, used by openViewModal so the panel open costs one fetch instead of
// three. The sub-panel refreshes (interface / sensor / IPsec / SD-WAN detail)
// deliberately omit it and re-read live, since they can run after a settings
// change.
async function _updateStreamSourceBadgesFromEffective(assetId, asset, effP) {
  if (!assetId || !asset) return;
  // _streamCredential needs the credential cache to resolve a class-override
  // *CredentialId into a name. Without this the badge silently falls through
  // to the integration's credential when the cache hasn't been warmed by
  // another surface (Server Settings / Monitoring Settings modal).
  if (!_credentialCache.loaded) await _ensureCredentials().catch(function () {});
  var eff;
  try { eff = await (effP || api.assets.effectiveMonitorSettings(assetId)); } catch (_) { return; }
  if (!eff || !eff.resolved) return;
  // Cache resolved settings so stale-banner slots can re-evaluate against
  // the class/integration tier; rewrite any slots already in the DOM.
  _effectiveResolvedByAssetId.set(assetId, eff.resolved);
  _updateStaleBannersFromEffective(assetId, asset);
  var spans = document.querySelectorAll('.asset-stream-source-badge[data-asset-id="' + (window.CSS && CSS.escape ? CSS.escape(assetId) : assetId) + '"]');
  spans.forEach(function (span) {
    var stream = span.getAttribute("data-stream");
    if (!stream) return;
    var prefix = _streamFieldPrefix(stream);
    var resolved = eff.resolved[prefix + "Polling"];
    // Tier-3 leaves polling null when the operator picked "Inherit" at every
    // tier — fall back to the source default the resolver applies at probe
    // time. The sync render already does this; without the parallel fallback
    // here, the async refresh would early-return and skip the cadence update,
    // leaving the badge stuck on "REST API (Direct) · Integration" without
    // the "every Nm" slot that the telemetry badge gets for free.
    if (!resolved) {
      var integration = asset.discoveredByIntegration;
      var sourceKind = (integration && integration.type) || "manual";
      if (!_POLLING_COMPAT[sourceKind]) sourceKind = "manual";
      resolved = _polarisSourceDefaultPolling(sourceKind, stream);
      if (!resolved) return; // truly not delivered (e.g. AD/Entra telemetry)
    }
    var prov = eff.provenance && eff.provenance[prefix + "Polling"];
    var intervalField = _streamIntervalEffectiveField(stream);
    var intervalSeconds = intervalField ? eff.resolved[intervalField] : null;
    // A caller-stated cadence (see _streamSourceBadgeHTML opts.intervalSec)
    // wins: the resolver's figure is the borrowed stream's, not this table's.
    if (span.hasAttribute("data-interval-sec")) {
      var stated = Number(span.getAttribute("data-interval-sec"));
      intervalSeconds = span.getAttribute("data-interval-sec") !== "" && isFinite(stated) ? stated : null;
    }
    // No "MIB:" segment: per-stream MIB pins are retired (business rule 170).
    span.textContent = _streamBadgeText(asset, stream, resolved, prov, intervalSeconds, eff.resolved);
    span.title = "Polling method · Where this setting comes from";
  });
}

// "Asset Override" badge rendered next to the Monitor Status pill on the
// asset details System tab. `monitorOverride` is an EXPLICIT operator-intent
// bit (set only at the moment an operator changes this asset's monitored
// state to something other than its integration's Auto-Monitor default) — it
// is no longer re-derived from incidental divergence, so the badge means
// "an operator deliberately pinned this," not merely "monitored happens to
// disagree with the flag right now." Discovery skips pinned assets. The
// adjacent Reset button clears the pin. Hidden for assets with no override.
function _assetOverrideBadge(a) {
  if (!a || a.monitorOverride !== true) return "";
  var tip = "An operator pinned this asset's monitored state, overriding the discovering integration's Auto-Monitor default. Discovery won't change it until the pin is reset.";
  return '<span class="badge badge-warning" title="' + escapeHtml(tip) + '" style="margin-left:6px">Asset Override</span>';
}

// "Reset to integration default" button — clears the override pin and
// realigns the asset to its integration's per-class Auto-Monitor flag.
// Shown only when a pin exists and the user can write.
function _assetOverrideResetBtn(a) {
  if (!a || a.monitorOverride !== true || !isUserOrAbove()) return "";
  return '<button class="btn btn-sm btn-secondary" id="btn-asset-monitor-reset" style="margin-left:8px" ' +
    'title="Clear this override and let discovery auto-manage the asset per the integration’s Auto-Monitor setting">Reset to integration default</button>';
}

function _assetDiscoverNowBtnHTML(a) {
  if (!_canEditAsset(a)) return "";
  var topo = a && a.fortinetTopology;
  var integ = a && a.discoveredByIntegration;
  var role = topo && topo.role;
  var isGate = role === "fortigate" && a.assetType === "firewall";
  var isInfra = role === "fortiswitch" || role === "fortiap";
  var fortinetIntg = integ && (integ.type === "fortimanager" || integ.type === "fortigate");
  // Directory assets scope by the identifier already on their AssetSource row
  // (Entra deviceId / AD objectGUID). The integration type is the cheap proxy
  // the panel has to hand; the server re-resolves from the source rows and
  // answers with a clear 400 if this asset has none.
  var isDirectory = integ && (integ.type === "entraid" || integ.type === "activedirectory"
    || integ.type === "vcenter" || integ.type === "azurearc");

  var disabledReason = "";
  if (integ && _isWorkloadPlatform(integ.type)) {
    // Mirrors NOT_YET_SCOPED in assetDiscoveryScope.ts: the whole host (or
    // the whole Proxmox cluster) is one read, so the integration's own
    // Discover is the refresh.
    disabledReason = "Unraid / TrueNAS / Proxmox read the whole host or cluster in one call — run Discover on the integration to refresh it. State and usage refresh every monitor tick.";
  } else if (!isGate && !isInfra && !isDirectory) {
    disabledReason = "No discovery source owns this asset, so there is nothing to re-run.";
  } else if (isGate && !fortinetIntg) {
    disabledReason = "This FortiGate is not owned by a FortiManager or FortiGate integration.";
  } else if (integ && integ.enabled === false) {
    disabledReason = 'Integration "' + (integ.name || "") + '" is disabled.';
  }
  if (disabledReason) {
    return '<button class="btn btn-sm btn-primary" id="btn-asset-discover-now" disabled ' +
      'title="' + escapeHtml(disabledReason) + '">Discover Now</button>';
  }

  // A switch/AP runs through its controller's integration, which need not be
  // the one that stamped the child — fall back to the child's own so the
  // in-flight check still lines up in the common single-integration case.
  var runIntegId = integ && integ.id;
  var running = runIntegId
    ? ((window._getServerDiscoveries && window._getServerDiscoveries()) || [])
        .find(function (d) { return d.id === runIntegId; })
    : null;
  if (running) {
    var deviceName = (topo && topo.deviceName) || (isInfra ? (topo && topo.controllerFortigate) : a.hostname) || "";
    var scopedToThis = running.scopeDeviceName && deviceName &&
      String(running.scopeDeviceName).toLowerCase() === String(deviceName).toLowerCase();
    var label = scopedToThis ? "Discovering…" : "Discovery running…";
    return '<button class="btn btn-sm btn-primary" id="btn-asset-discover-now" disabled ' +
      'title="A discovery is already running for ' + escapeHtml(integ.name) + '">' + label + '</button>';
  }

  var title;
  if (isInfra) {
    title = "Run discovery for this device's controller FortiGate: refreshes this " +
      (role === "fortiap" ? "FortiAP" : "FortiSwitch") + " and its siblings without a full sweep";
  } else if (isDirectory) {
    var sourceLabels = {
      entraid: "Entra ID / Intune",
      activedirectory: "Active Directory",
      vcenter: "vCenter",
      azurearc: "Azure Arc",
    };
    title = "Re-read just this device from " + (sourceLabels[integ.type] || "its integration") +
      " — no full sweep, and none of the fleet-wide passes (agent auto-deploy, auto-monitor, " +
      "presence verification, stale-source cleanup) a scheduled run performs";
  } else {
    title = "Run discovery for this FortiGate only: refresh its subnets, reservations, VIPs, " +
      "FortiSwitches and FortiAPs without a full " +
      (integ.type === "fortimanager" ? "FortiManager sweep" : "discovery cycle");
  }
  return '<button class="btn btn-sm btn-primary" id="btn-asset-discover-now" ' +
    'title="' + escapeHtml(title) + '">Discover Now</button>';
}

function assetMonitoringViewHTML(a) {
  if (!a) return '<p class="empty-state">No data.</p>';
  var pill = assetMonitorBadge(a);
  var overridePill = _assetOverrideBadge(a);
  var overrideReset = _assetOverrideResetBtn(a);
  if (!a.monitored) {
    // HA standby firewall: explain WHY it isn't monitored instead of the
    // generic enable-it hint — discovery sweeps standby members to
    // monitored=false every cycle (probes of the cluster IP only ever
    // measure the active member), so "go enable it" would be misleading.
    var haInfo = assetHaInfo(a);
    var unmonMsg;
    if (haInfo && haInfo.role === "secondary") {
      unmonMsg = 'HA standby firewalls are not monitored — the cluster IP routes to the active member, so a probe would only ever measure the primary. ' +
        'Health is tracked via the cluster’s HA roster on each discovery cycle' +
        (haInfo.memberStatus === "up" ? ' (currently reported up)' : haInfo.memberStatus === "down" ? ' (currently reported DOWN)' : '') +
        '. Polaris re-evaluates monitoring automatically when HA roles change on failover.';
    } else {
      unmonMsg = 'Monitoring is disabled for this asset. Enable it from the Edit modal’s Monitoring tab.';
    }
    return '<div style="padding:1rem 0">' +
      pill + overridePill + ' &nbsp; ' +
      '<span style="color:var(--color-text-secondary)">' + unmonMsg + '</span>' +
      overrideReset +
    '</div>';
  }
  // "Managed by" label: the integration that OWNS this asset's monitoring
  // configuration — `discoveredByIntegrationId`, the tier-3 class key of the
  // polling/credential resolver — with the parent FortiGate appended for
  // managed switches/APs. Single-valued by design: discovery guards the
  // column (first-writer-wins on the directory/cloud paths, unconditional
  // restamp for Fortinet managed infra), because the auto-monitor services,
  // agent auto-deploy and the decommission sweep all scope on it.
  //
  // Deliberately NOT discovery provenance — a multi-source asset (AD + Entra
  // + Intune + Arc) has one owning integration but many AssetSource rows, and
  // the Sources tab is what enumerates those. This row used to be labelled
  // "Source", which read as the provenance question it does not answer.
  // Manual assets say "Manual" rather than naming their response-time
  // transport: that belonged to the old "Source" framing (nothing is managing
  // the asset), and the transport + credential + cadence + tier are already
  // on the response-time chart's own badge a few rows below.
  var managedByLabel = a.discoveredByIntegration
    ? _assetIntegrationLabelWithController(a, ": ")
    : "Manual";
  // Admin-only "Dependency Test" trigger lives LEFT of the Status pill on
  // the System tab. Eligible for Fortinet infra only — workstations etc.
  // aren't part of the dependency tree, so the simulation has no children
  // to suppress and the backend rejects the call. Active state shows a
  // "Clear" button instead. Gated `assetMonitorSettings=fullwrite`
  // (canSimulateDependencyDown) — admin-only in every built-in role, and the
  // same level the route now requires: this WRITES, so it did not belong on
  // the read-only probe key. Business rule 43.
  var depTestBtn = "";
  var isInfraType = a.assetType === "firewall" || a.assetType === "switch" || a.assetType === "access_point";
  var depTestActiveNow = a.dependencyTestUntil && new Date(a.dependencyTestUntil).getTime() > Date.now();
  if (canSimulateDependencyDown() && a.monitored && isInfraType) {
    if (depTestActiveNow) {
      depTestBtn = '<button class="btn btn-sm btn-secondary" onclick="clearDependencyTestNow(' + jsArg(a.id) + ')" style="margin-right:6px" title="Stop the simulation immediately and let children resume">Clear Dep. Test</button>';
    } else {
      depTestBtn = '<button class="btn btn-sm btn-secondary" onclick="startDependencyTestPrompt(' + jsArg(a.id) + ')" style="margin-right:6px" title="Admin-only: simulate this device going down to see how children react. Real probes keep running.">Simulate Down</button>';
    }
  }
  var rangeBtns =
    _chartRangeBtnsHTML("asset-monitor-range-btn", [
      { value: "1h",  label: "1h" },
      { value: "12h", label: "12h" },
      { value: "24h", label: "24h" },
      { value: "7d",  label: "7d" },
      { value: "30d", label: "30d" },
      { value: "custom", label: "Custom…", id: "btn-asset-monitor-custom" },
    ], "assetMonitor", "24h");
  var customPanel =
    '<div id="asset-monitor-custom-panel" style="display:none;align-items:center;gap:6px;margin:0.5rem 0;padding:0.5rem;background:var(--color-bg-primary);border:1px solid var(--color-border);border-radius:6px;font-size:0.85rem">' +
      '<label style="display:flex;align-items:center;gap:4px">From <input type="datetime-local" id="asset-monitor-from" class="form-input" style="padding:2px 6px"></label>' +
      '<label style="display:flex;align-items:center;gap:4px">To <input type="datetime-local" id="asset-monitor-to" class="form-input" style="padding:2px 6px"></label>' +
      '<button class="btn btn-sm btn-primary" id="btn-asset-monitor-custom-apply">Apply</button>' +
    '</div>';
  // Uptime row — only rendered when the probe path captured uptime (SNMP /
  // FortiOS / agent; ICMP/SSH/WinRM-only assets show no row). lastUptimeSec is
  // the reading at the last probe (lastMonitorAt); extrapolate to "now" unless
  // the asset is down (a dead box's uptime shouldn't keep climbing). The
  // "since" reboot timestamp prefers the reboot-detected lastRebootAt; absent
  // that, it's the boot instant derived from the reading (stable across
  // extrapolation).
  var uptimeRow = "";
  if (a.lastUptimeSec != null && a.lastMonitorAt) {
    var _obsUp = Number(a.lastUptimeSec);
    var _obsAt = new Date(a.lastMonitorAt).getTime();
    var _elapsed = Math.max(0, Math.floor((Date.now() - _obsAt) / 1000));
    var _upNow = a.monitorStatus === "down" ? _obsUp : _obsUp + _elapsed;
    var _sinceMs = a.lastRebootAt ? new Date(a.lastRebootAt).getTime() : (_obsAt - _obsUp * 1000);
    var _since = new Date(_sinceMs).toLocaleString(undefined,
      Object.assign({ month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }, timeZoneOpts()));
    uptimeRow =
      '<div class="detail-row" title="' + escapeHtml("Uptime as of " + timeAgo(a.lastMonitorAt)) + '">' +
        '<span class="detail-label">Uptime</span>' +
        '<span class="detail-value">' + escapeHtml(formatUptime(_upNow)) +
          ' <span style="color:var(--color-text-tertiary)">· since ' + escapeHtml(_since) + '</span>' +
        '</span></div>';
  }
  return (
    '<div data-shot-section="status" data-shot-label="Status &amp; Monitoring">' +
    '<div class="asset-view-grid">' +
      // Status uses a raw-HTML row because viewRow() escapes its value and
      // would render the badge markup as text.
      // The pill + override badge live in an id'd wrapper so the Refresh
      // button's probe-now handler can re-render just the Status after a probe
      // (a down→up flip would otherwise leave the pill stale). depTestBtn sits
      // outside the wrapper, left of it — a probe never changes the
      // dependency-test state. Discover Now and Reboot live in the panel
      // header (_assetHeaderVerbsHTML), not here.
      '<div class="detail-row"><span class="detail-label">Status</span>' +
        '<span class="detail-value">' + depTestBtn + '<span id="asset-status-pill-wrap">' + pill + overridePill + '</span>' + overrideReset + '</span></div>' +
      // Last hour intermittency bar — one cell per probe sample, colored
      // by the resolved monitor state at that point. Sits in a single
      // grid column (half the panel); the value cell is flex:1 so the bar
      // fills the column's value-side rather than collapsing to the natural
      // width of the "Nh ago/N samples/now" caption underneath. Loaded
      // asynchronously by _renderIntermittencyBar(). Hidden on unmonitored
      // assets.
      (a.monitored
        ? '<div class="detail-row"><span class="detail-label">Last 30 min</span>' +
            '<span class="detail-value" id="asset-intermittency-bar" data-asset-id="' + escapeHtml(a.id) + '" style="flex:1">' +
              '<span style="font-size:0.78rem;color:var(--color-text-tertiary)">Loading…</span>' +
            '</span></div>'
        : '') +
      viewRow("Managed by", managedByLabel) +
      uptimeRow +
    '</div>' +
    '</div>' +
    '<div data-shot-section="responseTime" data-shot-label="Response Time" data-shot-chart="assetMonitor">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin:1.5rem 0 0.5rem">' +
      '<div style="display:flex;align-items:baseline;gap:0.5rem;flex-wrap:wrap">' +
        '<h4 style="margin:0">Response time</h4>' +
        _streamSourceBadgeHTML(a, "responseTime") +
      '</div>' +
      '<div style="display:flex;gap:6px">' + rangeBtns + '</div>' +
    '</div>' +
    customPanel +
    '<div id="asset-monitor-stale"></div>' +
    '<div id="asset-monitor-stats" style="display:flex;gap:1.25rem;flex-wrap:wrap;font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.5rem"></div>' +
    // Filled by _renderMonitorChart with a key for the colours it drew (and
    // the Max chip on a rollup tier). Above the plot, where every other
    // chart's legend sits; it must stay the chart's previous sibling.
    '<div class="chart-state-legend"></div>' +
    '<div id="asset-monitor-chart" class="chart-box" style="min-height:200px;display:flex;align-items:center;justify-content:center;color:var(--color-text-secondary);font-size:0.85rem">' +
      'Loading samples…' +
    '</div>' +
    '</div>'
  );
}

/**
 * The Last-30-min strip's and the response-time chart's state replay — the
 * shared one in public/js/monitor-states.js, which the phone app reads too.
 * Kept as a local name because both call sites, the strip's legend and
 * tests/unit/assetIntermittencyBar.test.ts all speak of it that way.
 */
function _intermittencyStates(samples, threshold, recoveryPolls) {
  return window.PolarisMonitorStates.replay(samples, threshold, recoveryPolls);
}

/**
 * Renders a thin colored bar under the Status row on the asset System tab.
 * Each cell = one probe sample over the last 30 minutes, colored by
 * _intermittencyStates' replay of the five-state machine so the bar reads as
 * the same vocabulary as the Status pill above it. The replay walks the FULL
 * hour and only the trailing 30 cells are shown, so both counters are warmed
 * up across the window boundary — a dip that started before the visible
 * window keeps its correct red/yellow, and a recovery that started before it
 * keeps its blue. A miss the upstream explains is drawn in the dependency grey
 * instead of amber or the Down colour, the same override the response-time
 * chart applies (business rule 38) — the two are stacked, so a suppressed
 * outage has to read the same on both. Runs once on tab open; not
 * auto-refreshed (the sample chart above already auto-refreshes and this
 * mostly serves as an at-a-glance intermittency indicator).
 */
// `effP` (optional) — same shared-fetch contract as
// _updateStreamSourceBadgesFromEffective: openViewModal hands over this open's
// single effective-monitor-settings promise.
async function _renderIntermittencyBar(assetId, effP) {
  var slot = document.getElementById("asset-intermittency-bar");
  if (!slot || slot.getAttribute("data-asset-id") !== assetId) return;
  // Fetch in parallel: 1h sample stream (trimmed to last 30) + the resolved
  // threshold for the state-machine replay. Both are best-effort; if either
  // fails we fall back to a sensible default so the bar still renders.
  var allSamples = [];
  var threshold = 3;
  var recoveryPolls = 0;
  var downAutomation = null;
  // The covering automation's severity — the colour a Down cell takes. Null
  // until resolved, and null on a passive device, which never reaches Down.
  var downSeverity = null;
  try {
    var results = await Promise.all([
      api.assets.monitorHistory(assetId, "1h").catch(function () { return null; }),
      (effP || api.assets.effectiveMonitorSettings(assetId)).catch(function () { return null; }),
    ]);
    allSamples = (results[0] && Array.isArray(results[0].samples)) ? results[0].samples : [];
    // The count comes from the covering down-detection automation now, not
    // from the settings tier (business rule 36) — and `passive` means there is
    // no count at all, so no sample can be "the Nth consecutive failure that
    // makes it Down". Rendering red there would assert a verdict Polaris
    // deliberately never reaches.
    var ddInfo = results[1] && results[1].downDetection;
    if (ddInfo && ddInfo.passive) threshold = null;
    else if (ddInfo && Number.isFinite(ddInfo.missedPolls)) threshold = ddInfo.missedPolls;
    if (ddInfo && !ddInfo.passive) {
      if (Number.isFinite(ddInfo.recoveryPolls)) recoveryPolls = ddInfo.recoveryPolls;
      downAutomation = ddInfo.automationName || null;
      downSeverity = ddInfo.severity || null;
    }
    if (results[1] && results[1].resolved) {
      // Populate the shared cache so stale-banner slots see the resolved
      // class/integration cadence as soon as this fetch lands (covers the
      // case where the response-time chart loads before the System tab is
      // opened).
      _effectiveResolvedByAssetId.set(assetId, results[1].resolved);
      _updateStaleBannersFromEffective(assetId, _currentAssetForRefresh);
    }
  } catch (_) { /* fall through with defaults */ }

  if (allSamples.length === 0) {
    slot.innerHTML = '<span style="font-size:0.78rem;color:var(--color-text-tertiary)">No samples in the last 30 minutes</span>';
    return;
  }
  // The replay answers "which state is this probe in", never "why" — dependency
  // suppression is orthogonal to the leaky bucket and deliberately does not
  // enter it (business rule 38: the probe keeps running while suppressed, which
  // is what detects the parent's recovery, so the misses are real misses). The
  // flag therefore rides ALONGSIDE the replay, zipped back on by index before
  // the 30-cell window is trimmed — exactly as the response-time chart below
  // layers grey over the point colour it has already computed.
  var states = _intermittencyStates(allSamples, threshold, recoveryPolls).map(function (st, i) {
    var s = allSamples[i];
    // Only a FAILED probe can carry the flag — the server writes it on misses
    // alone — so a probe that ANSWERED under a dark parent keeps its green or
    // blue. That is not a technicality: an answer is real evidence the device
    // is there, and greying it would hide the one cell that says so.
    st.dep = !st.success && !!(s && s.dependencyDown === true);
    return st;
  }).slice(-30);

  // Color map mirrors badge-monitor-* hues so the bar reads as the same
  // visual vocabulary as the pill above it. This bar only ever emits
  // up / recovering / warning / down per sample, plus the dependency grey
  // layered over a miss; unknown remains the fallback color.
  //
  // `recovering` is BLUE, agreeing with the pill above rather than contradicting
  // it: on this strip it means "this probe answered while misses are still
  // outstanding", and the operator reads the bar as a running tally — amber
  // climbing, blue paying it back. Same value as _CHART_RECOVER_COLOR on the
  // response-time chart immediately below, which is the whole point.
  //
  // It was the magenta-leaning purple 400 until 2026-08-29, picked when the
  // chart's series was still the theme accent and blue would have collided with
  // it. The series is the Up green now, so the blue is free — and it never sat
  // comfortably one shade from the muted lavender #9575cd that means
  // MAINTENANCE elsewhere in the product.
  // `down` is the ONE cell whose hue is not fixed: it is the covering
  // automation's severity (business rule 36), so an outage an operator rated
  // `warning` reads amber-yellow here and in the chart below rather than in a
  // red they never asked for. Resolved through the same
  // PolarisChartSeverity.downColorOf the chart uses, then given the strip's own
  // alpha so it sits in the same visual weight as its neighbours. Unresolved
  // severity falls back to the red Down has always been.
  var downHex = (window.PolarisChartSeverity && downSeverity)
    ? window.PolarisChartSeverity.downColorOf(downSeverity)
    : "#d32f2f";
  var colors = {
    up:         "rgba(0,200,83,0.65)",
    recovering: "rgba(2,136,209,0.80)",
    warning:    "rgba(255,193,7,0.75)",
    down:       _hexWithAlpha(downHex, 0.75),
    unknown:    "rgba(117,117,117,0.45)",
    // NOT a replay state — an OVERLAY on a miss, the same grey and the same
    // precedence the response-time chart gives it in _chartPointColor. A probe
    // that missed while the parent was dark is not being counted against this
    // device at all, so how close it sits to the threshold says nothing worth
    // colouring: the strip goes quiet rather than drawing 30 cells of alarm
    // about an outage Polaris has already explained. Shares _CHART_DEP_COLOR
    // with the chart directly below and the alert email, at the strip's own
    // alpha so it carries the same visual weight as its neighbours.
    dep:        _hexWithAlpha(_CHART_DEP_COLOR, 0.75),
  };
  // Each cell flexes to 1fr so the bar always fills the column regardless
  // of how many samples landed in the hour. Tooltip carries the timestamp +
  // status so an operator can hover to inspect a specific dip.
  // Tooltip states the RUNNING COUNT, not just the state name: the strip's job
  // is letting an operator follow a flapping device probe by probe, and "Missed"
  // on four cells in a row does not say whether the device is climbing toward
  // Down or paying its way back out. Each cell reports where the bucket stood
  // AFTER that probe, plus the direction it moved.
  var cellHTML = states.map(function (st) {
    var ts = new Date(st.timestamp).toLocaleTimeString(undefined, timeZoneOpts());
    var color = st.dep ? colors.dep : (colors[st.status] || colors.unknown);
    var n = st.missed || 0;
    var what;
    if (!st.success)        what = "Missed " + n + " (+1)";
    // A recovering probe reports BOTH halves: how far through the climb it is
    // (the bucket's cap is what a declared outage owes) and how much debt is
    // left. One without the other reads as either "why is this still blue" or
    // "how much longer".
    else if (st.confirming) what = "Received " + st.confirming.done + "/" + st.confirming.need +
                                   " — " + n + " missed outstanding (−1)";
    else                    what = "Received — recovered";
    // Dependency-down outranks the Down label, matching the Status pill above:
    // assetMonitorBadge reads "Dep. Down", not "Down", while the parent is dark
    // (the five-state machine keeps running underneath either way). The cell is
    // grey, the pill says Dep. Down, and now the tooltip agrees with both.
    if (st.dep) what += " · Dep. Down — upstream parent was down";
    else if (st.status === "down") what += " · Down";
    return '<div title="' + escapeHtml(ts + " · " + what) + '" style="flex:1;background:' + color + '"></div>';
  }).join("");
  // Name the automation the bar is drawn from. Both counts are its counts —
  // the missed-poll threshold that turns a cell to the Down colour and the
  // recovery run that keeps it blue — so an operator reading the strip against
  // their automation can see the two numbers rather than infer them from the
  // colors.
  var legend;
  if (threshold === null) {
    legend = 'No down automation covers this device — Polaris renders no verdict';
  } else {
    legend = 'Down after ' + threshold + ' missed · Up after ' +
      (recoveryPolls > threshold ? recoveryPolls : threshold) + ' received' +
      (downAutomation ? ' — ' + escapeHtml(downAutomation) : '');
  }
  // Name the grey when any of the 30 visible cells is one, so the colour is
  // self-explaining on the one page an operator opens BECAUSE something looks
  // wrong. Without it a strip full of grey reads as "no data" — the opposite of
  // what it means, which is that Polaris knows exactly why these polls missed.
  if (states.some(function (st) { return st.dep; })) {
    legend += ' · Grey — missed while the upstream parent was down';
  }
  slot.innerHTML =
    '<div style="display:flex;height:14px;width:100%;border:1px solid var(--color-border);border-radius:3px;overflow:hidden;gap:1px;background:var(--color-bg-primary)">' +
      cellHTML +
    '</div>' +
    '<div style="display:flex;justify-content:space-between;font-size:0.7rem;color:var(--color-text-tertiary);margin-top:2px">' +
      '<span>30m ago</span>' +
      '<span>' + states.length + ' sample' + (states.length === 1 ? '' : 's') + '</span>' +
      '<span>now</span>' +
    '</div>' +
    '<div style="font-size:0.7rem;color:var(--color-text-tertiary);margin-top:2px">' + legend + '</div>';
}

/**
 * Fetches asset.updated events for one asset within the chart window and
 * returns transition markers — one per event whose change-set touched the
 * polling-method fields (responseTimePolling / cpuMemoryPolling /
 * interfacesPolling / lldpPolling) or monitorCredentialId. Each marker
 * carries { timestamp, label } so the chart can render a vertical line at
 * that timestamp with the human-readable transition string in its tooltip.
 *
 * Bounded by the events table's 7-day rolling retention. Older events
 * have been pruned and won't appear; that's acceptable for an
 * intermittency-investigation tool — the markers are most useful for
 * recent changes anyway.
 */
async function _fetchPollingTransitions(assetId, since, until) {
  var TRACKED = {
    responseTimePolling:       "Response-time polling",
    cpuMemoryPolling:          "Telemetry polling",
    interfacesPolling:         "Interfaces polling",
    lldpPolling:               "LLDP polling",
    storagePolling:            "Storage polling",
    monitorCredentialId:       "Credential",
  };
  var params = {
    resourceType: "asset",
    resourceId:   assetId,
    action:       "asset.updated",
    limit:        200,
  };
  if (since) params.since = since;
  if (until) params.until = until;
  var resp;
  try { resp = await api.events.list(params); }
  catch (_) { return []; }
  var events = (resp && resp.events) || [];
  var markers = [];
  events.forEach(function (e) {
    var changes = e && e.details && e.details.changes;
    if (!changes || typeof changes !== "object") return;
    var bits = [];
    Object.keys(TRACKED).forEach(function (field) {
      var c = changes[field];
      if (!c) return;
      // c is { from, to } per buildChanges() convention.
      var from = c.from === null || c.from === undefined ? "—" : String(c.from);
      var to   = c.to   === null || c.to   === undefined ? "—" : String(c.to);
      bits.push(TRACKED[field] + ": " + from + " → " + to);
    });
    if (bits.length === 0) return;
    markers.push({ timestamp: e.timestamp, label: bits.join("\n") });
  });
  // Server returns newest-first; sort ascending so the chart's left-to-right
  // overlay matches time order regardless.
  markers.sort(function (a, b) { return new Date(a.timestamp) - new Date(b.timestamp); });
  return markers;
}

async function _loadMonitorHistoryFor(assetId, selection, callOpts) {
  // Cancel any pending auto-refresh — a manual range change or probe-now click
  // shouldn't race against an in-flight scheduled tick.
  if (_assetMonitorRefreshTimer) { clearTimeout(_assetMonitorRefreshTimer); _assetMonitorRefreshTimer = null; }
  var silent = !!(callOpts && callOpts.silent);
  var chart = document.getElementById("asset-monitor-chart");
  var stats = document.getElementById("asset-monitor-stats");
  if (!chart) return;
  if (!silent) {
    chart.textContent = "Loading samples…";
    if (stats) { stats.textContent = ""; delete stats.dataset.summary; }
  }
  var opts = (typeof selection === "string" || !selection) ? { range: selection || "24h" } : selection;
  // Persist selection so probe-now can refresh the same view.
  if (opts.from && opts.to) {
    chart.dataset.from = opts.from;
    chart.dataset.to = opts.to;
    delete chart.dataset.range;
  } else {
    chart.dataset.range = opts.range || "24h";
    delete chart.dataset.from;
    delete chart.dataset.to;
  }
  var panelBody = silent ? document.getElementById("asset-panel-body") : null;
  var savedScroll = panelBody ? panelBody.scrollTop : 0;
  // A container with no address of its own answers on its host's: the only
  // latency there is to chart is the host's, so the chart shows that, and
  // says so.
  var current = _currentAssetForRefresh && _currentAssetForRefresh.id === assetId ? _currentAssetForRefresh : null;
  var proxyHost = _responseTimeHostFor(current);
  var historyId = proxyHost ? proxyHost.id : assetId;
  _renderResponseTimeSourceNote(chart, proxyHost, current);
  try {
    var data = await api.assets.monitorHistory(historyId, opts);
    // Fetch transitions in parallel — failures are non-fatal (chart still
    // renders without markers). Scoped to the chart's window when available
    // so we don't pull every asset.updated event Polaris has ever seen.
    var transitions = [];
    try {
      transitions = await _fetchPollingTransitions(historyId, data && data.since, data && data.until);
    } catch (_) { /* defensive */ }
    _renderMonitorChart(chart, data, transitions);
    _updateMonitorStaleBanner(assetId, data, opts);
    if (stats && data.stats) {
      var s = data.stats;
      var monitorParts = [
        { label: "Avg",         value: s.avgMs != null ? s.avgMs + " ms" : "—" },
        { label: "Min",         value: s.minMs != null ? s.minMs + " ms" : "—" },
        { label: "Max",         value: s.maxMs != null ? s.maxMs + " ms" : "—" },
        // The loss line's own window ratio (every probe kind, packets counted)
        // when the payload carries one, so the figure is what the dashed line
        // averages to; the poll-outcome rate only for an older payload.
        { label: "Packet loss", value: (data.loss && data.loss.ratioPct != null)
            ? Number(data.loss.ratioPct).toFixed(1) + "%"
            : s.packetLossRate != null ? (s.packetLossRate * 100).toFixed(1) + "%" : "—" },
      ];
      var monitorTierPart = _tierStatsPart(data);
      if (monitorTierPart) monitorParts.unshift(monitorTierPart);
      _renderChartStats(stats, s.total, monitorParts);
    }
  } catch (err) {
    if (!silent) chart.textContent = "Error: " + (err.message || "failed to load history");
    // Silent ticks leave stale content in place on transient errors.
  }
  if (panelBody) {
    panelBody.scrollTop = savedScroll;
    requestAnimationFrame(function () {
      if (panelBody.scrollTop !== savedScroll) panelBody.scrollTop = savedScroll;
    });
  }
  // Custom date ranges are fixed historical windows — do not auto-refresh.
  if (opts.from && opts.to) return;
  var settings = _monitorSettingsCache || {};
  var asset = _currentAssetForRefresh;
  var ms = _refreshIntervalMs(asset && asset.monitorIntervalSec, settings.intervalSeconds, 60);
  _scheduleAssetMonitorRefresh(assetId, ms);
}

/**
 * The host whose response time stands in for this asset's: an Unraid
 * container / TrueNAS App that has no address of its own (host or bridge
 * networking — it answers on its host's address). Null for everything else,
 * including a container an operator gave an address by hand.
 */
function _responseTimeHostFor(asset) {
  var v = asset && asset.virtualization;
  if (!v || v.role !== "container" || !v.hostAssetId) return null;
  // Not Proxmox: an LXC with no known address still has its own NIC — it does
  // not answer on its node's address the way a host-networked Docker container does.
  if (v.platform !== "unraid" && v.platform !== "truenas") return null;
  if (asset.ipAddress) return null;
  return { id: v.hostAssetId, name: v.hostName || null, networkMode: v.networkMode || null };
}

function _renderResponseTimeSourceNote(chart, proxyHost, asset) {
  var id = "asset-monitor-source-note";
  var note = document.getElementById(id);
  if (!proxyHost) { if (note) note.remove(); return; }
  if (!note) {
    note = document.createElement("p");
    note.id = id;
    note.className = "hint";
    note.style.cssText = "margin:0 0 0.5rem;padding:0.45rem 0.65rem;background:var(--color-bg-tertiary);border-radius:var(--radius-sm);color:var(--color-text-secondary)";
    chart.parentNode.insertBefore(note, chart);
  }
  var what = asset && asset.virtualization && asset.virtualization.platform === "truenas" ? "App" : "container";
  var mode = proxyHost.networkMode ? " (network: " + escapeHtml(proxyHost.networkMode) + ")" : "";
  note.innerHTML = "This chart is the host's response time — " +
    '<a href="#" class="dep-tree-link" data-asset-id="' + escapeHtml(proxyHost.id) + '">' + escapeHtml(proxyHost.name || "the host") + '</a>. ' +
    "This " + what + mode + " has no address of its own, so it answers on its host's; " +
    "whether it is up is read from the host's API and shown in its monitor status, not in this chart.";
  _wireDependencyTreeLinks(note);
}

function _currentMonitorSelection() {
  var chart = document.getElementById("asset-monitor-chart");
  if (!chart) return "24h";
  if (chart.dataset.from && chart.dataset.to) {
    return { from: chart.dataset.from, to: chart.dataset.to };
  }
  return chart.dataset.range || "24h";
}

// Amber stale banner above the Response Time chart — same style + wording as
// every other section's banner ("Last successful update X ago"). The last
// successful probe comes from the payload's `lastSuccessAt` on rollup tiers
// (7d/30d), because a rollup sample's timestamp is its BUCKET START: the
// newest daily bucket is up to 24h old the moment it's written, which made a
// healthy 1-minute probe read as hours stale as soon as the operator switched
// to 30d. On the detail tier the newest sample with a response is itself the
// answer, so the series is derived instead — and it also covers the rollup
// case where the last success predates detail retention (server sends null).
// Either way the banner updates on every load/auto-refresh tick. Custom
// from/to windows are fixed historical views and say nothing about live
// freshness, so the banner clears there. When the live window contains
// samples but no successes at all, the probe has been failing for at least
// the whole window — say so rather than staying silent.
function _updateMonitorStaleBanner(assetId, data, opts) {
  var slot = document.getElementById("asset-monitor-stale");
  if (!slot) return;
  if (opts && opts.from && opts.to) { slot.innerHTML = ""; return; }
  var samples = (data && data.samples) || [];
  var lastOk = (data && data.lastSuccessAt) || null;
  for (var i = samples.length - 1; !lastOk && i >= 0; i--) {
    var s = samples[i];
    var ok = (typeof s.successCount === "number") ? s.successCount > 0 : !!s.success;
    if (ok) { lastOk = s.timestamp; break; }
  }
  if (lastOk) {
    slot.innerHTML = _staleBannerHTML(assetId, _currentAssetForRefresh, "responseTime", lastOk);
  } else if (samples.length) {
    slot.innerHTML = _staleBannerBoxHTML(
      "No successful update in the last " + (opts && opts.range ? opts.range : "window"));
  } else {
    slot.innerHTML = "";
  }
}

function _toLocalDatetimeInput(d) {
  // Render a Date as "YYYY-MM-DDTHH:MM" in the user's local time zone for <input type="datetime-local">.
  function pad(n) { return n < 10 ? "0" + n : String(n); }
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
    "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

// The key above a chart — one entry per colour the chart actually DREW, never
// the whole vocabulary: a key naming a colour the reader cannot find is noise.
// `entries` are { label, color, style } with style "line" | "dash" | "band";
// the alert email draws the same key into its PNG (legendSvg in
// utils/sparklineSvg.ts), with the same names.
// `extraHTML` (optional) is appended to the row — the response-time chart's
// Max chip on a rollup tier. The row sits above the plot.
function _chartStateLegendHTML(entries, extraHTML) {
  if ((!entries || !entries.length) && !extraHTML) return "";
  entries = entries || [];
  return '<div style="display:flex;flex-wrap:wrap;gap:4px 14px;font-size:0.72rem;color:var(--color-text-secondary);margin-bottom:4px">' +
    entries.map(function (e) {
      var swatch = e.style === "band"
        ? '<span style="width:12px;height:9px;flex:0 0 auto;background:' + e.color + ';border:1px dashed ' + (e.border || e.color) + '"></span>'
        : '<span style="width:14px;height:0;flex:0 0 auto;border-top:2px ' + (e.style === "dash" ? "dashed" : "solid") + ' ' + e.color + '"></span>';
      return '<span style="display:inline-flex;align-items:center;gap:5px">' + swatch + escapeHtml(e.label) + '</span>';
    }).join("") +
    (extraHTML || "") +
  '</div>';
}

function _renderMonitorChart(container, data, transitions) {
  var samples = (data && data.samples) || [];
  // The key sits ABOVE the plot, as every other chart's legend does (the CPU
  // chart's chips, the SD-WAN member legend): it is the chart's previous
  // sibling in the section markup (assetMonitorViewHTML).
  var legendSlot = container.previousElementSibling && container.previousElementSibling.classList.contains("chart-state-legend")
    ? container.previousElementSibling : null;
  if (legendSlot) legendSlot.innerHTML = "";
  if (samples.length === 0) {
    container.textContent = "No samples in this range yet.";
    return;
  }
  transitions = Array.isArray(transitions) ? transitions : [];
  // Packet loss rides a right-hand axis of its own (see _CHART_LOSS_COLOR). An
  // older payload without `loss`, or a window with nothing countable, keeps the
  // single-axis chart and its narrow right gutter.
  var lossSeries = (data && data.loss) || null;
  var lossPoints = (lossSeries && Array.isArray(lossSeries.points)) ? lossSeries.points : [];
  var hasLoss = lossPoints.length > 0;
  var W = container.clientWidth || 600;
  var H = 200;
  var padL = 56, padR = hasLoss ? 46 : 10, padT = 10, padB = 56;
  var innerW = W - padL - padR;
  var innerH = H - padT - padB;

  var bounds = _chartTimeBounds(samples, data && data.since, data && data.until);
  var t0 = bounds.t0, t1 = bounds.t1;
  var spanMs = t1 - t0;
  var oneDayMs = 24 * 60 * 60 * 1000;
  var pad2 = _chartPad2;

  // Tier-aware sample classification. The detail tier carries a per-sample
  // `success` boolean; the rollup tiers (hourly/daily) instead carry
  // successCount/failureCount per bucket with the bucket average in
  // responseTimeMs. A sample "has a response" (gets a dot + joins the line)
  // when it's a successful detail sample OR a rollup bucket with ≥1 success and
  // a numeric average. A sample is a "failure" (red line) only when it's a
  // failed detail sample OR a *fully*-failed rollup bucket (successCount === 0);
  // a partial-loss bucket still plots its average instead of reading as a total
  // outage. Without this the renderer keyed off `success` alone, so every
  // rollup bucket (no `success` field) became a failure line and none plotted.
  function ptHasResponse(s) {
    if (typeof s.successCount === "number") return s.successCount > 0 && typeof s.responseTimeMs === "number";
    return s.success && typeof s.responseTimeMs === "number";
  }
  function ptIsFailure(s) {
    if (typeof s.successCount === "number") return s.sampleCount > 0 && s.successCount === 0;
    return !s.success;
  }
  // Was the miss EXPLAINED — the asset dependency-suppressed, its parent dark?
  // Detail rows carry the flag per sample; a rollup bucket only counts when
  // EVERY failure in it was one, since a bucket that mixes explained and
  // unexplained misses still contains an outage nobody accounted for.
  function ptIsDependency(s) {
    if (typeof s.successCount === "number") {
      return s.failureCount > 0 && (s.dependencyFailureCount || 0) >= s.failureCount;
    }
    return s.dependencyDown === true;
  }

  var oks = samples.filter(ptHasResponse);
  var maxRtt = oks.length ? Math.max.apply(null, oks.map(function (s) { return s.responseTimeMs; })) : 100;
  // Rollup tiers: each bucket's peak as a dashed line (_maxLineSVG), and the
  // axis grows to hold it while it is shown — never clipped off the top.
  // Only buckets with a success have a max worth drawing; only those inside
  // the visible window may raise the axis (_inChartWindow).
  var rollupTier = _chartRollupTier(data);
  var showMax = !!rollupTier && _getMaxLinePref("assetMonitor");
  function ptMax(s) {
    return ptHasResponse(s) && typeof s.maxResponseTimeMs === "number" && isFinite(s.maxResponseTimeMs) ? s.maxResponseTimeMs : null;
  }
  if (showMax) {
    _inChartWindow(oks, data && data.since).forEach(function (s) {
      var m = ptMax(s);
      if (m != null && m > maxRtt) maxRtt = m;
    });
  }
  if (maxRtt < 50) maxRtt = 50;
  // round up to a tidy ceiling
  var step = maxRtt > 1000 ? 250 : maxRtt > 200 ? 50 : 10;
  var ceil = Math.ceil(maxRtt / step) * step;
  // The loss axis scales to the worst bucket in the window rather than pinning
  // at 100 % — a 2 % blip on a 0–100 axis hugs the baseline and reads as none.
  // Ceilings are picked so the quarter labels stay whole percentages.
  var lossCeil = 100;
  if (hasLoss) {
    var maxLoss = Math.max.apply(null, lossPoints.map(function (p) { return Number(p.v) || 0; }));
    var lossSteps = [4, 8, 12, 20, 40, 60, 80, 100];
    for (var li = 0; li < lossSteps.length; li++) {
      if (maxLoss <= lossSteps[li]) { lossCeil = lossSteps[li]; break; }
    }
  }

  var xFor = _chartXScale(padL, innerW, t0, t1);
  var yFor = _chartYScale(padT, innerH, 0, ceil);

  // Failure-aware line: failed polls plot as dots at 0 ms (the chart baseline)
  // and stay connected to their neighbors — the connecting segment fades
  // between the two colors so an outage reads as the line diving to zero rather
  // than the old full-height vertical failure lines.
  //
  // The COLORS come from the same replay the Last-30-min strip runs
  // (_intermittencyStates), not from a second copy of the leaky bucket: the
  // strip sits directly above this chart and the two describing the same probe
  // differently is exactly the confusion this vocabulary exists to prevent. Its
  // four states ARE the four colors — up green, warning amber, down red,
  // recovering purple — with grey layered on top for a miss the upstream
  // explains. That is also what puts the automation's RESET in the picture: a
  // "down after 3 missed, up after 5 received" automation keeps the climb
  // purple for all five answers, not just the three the bucket's drain costs
  // (business rule 36).
  //
  // `downDetection` rides the history payload so it lands with the samples;
  // `passive` means no automation defines Down here, so nothing goes red. Its
  // ABSENCE is the unknown case — an older payload, or a resolve that failed —
  // and keeps every miss red rather than inventing a threshold to be amber
  // about.
  var dd = (data && data.downDetection) || null;
  var thresholdKnown = !!dd;
  // The colour a `down` probe is drawn in — the covering automation's own
  // severity (business rule 36). A passive device never reaches `down`, and an
  // unresolved one keeps the red it has always had.
  var downColor = (window.PolarisChartSeverity && dd && !dd.passive)
    ? window.PolarisChartSeverity.downColorOf(dd.severity)
    : _CHART_FAIL_COLOR;
  var states = _intermittencyStates(
    // Rollup tiers carry no per-sample `success`, so the bucket reads the same
    // fully-failed-bucket rule the plot does: a bucket with any success in it
    // answered. On those tiers the amber/red split is coarse by construction —
    // a whole hour with zero successes is Down under any threshold — and it is
    // exact on the detail tier, which is where an operator reads a flap.
    samples.map(function (s) { return { timestamp: s.timestamp, success: !ptIsFailure(s) }; }),
    dd ? (dd.passive ? null : dd.missedPolls) : null,
    dd && !dd.passive && dd.recoveryPolls != null ? dd.recoveryPolls : 0,
  );
  var statusAt = function (i) { return (states[i] && states[i].status) || "up"; };
  var linePts = [];
  // The max line takes the SAME per-bucket colour as the average point beside
  // it (Up green, or the recovering blue on the climb back), and breaks on a
  // bucket with no success — there is no peak response in a bucket that got
  // none.
  var maxPts = [];
  samples.forEach(function (s, i) {
    if (ptHasResponse(s)) {
      var okPt = { x: xFor(s.timestamp), y: yFor(s.responseTimeMs), ok: true, rec: statusAt(i) === "recovering" };
      linePts.push(okPt);
      var m = ptMax(s);
      maxPts.push(m == null ? null : { x: okPt.x, y: yFor(m), color: _chartPointColor(okPt, _CHART_UP_COLOR) });
    } else if (ptIsFailure(s)) {
      maxPts.push(null);
      linePts.push({
        x: xFor(s.timestamp), y: padT + innerH, ok: false,
        dep: ptIsDependency(s),
        down: !thresholdKnown || statusAt(i) === "down",
        downColor: downColor,
      });
    }
  });

  function fmtTooltipTs(ts) {
    return _fmtTooltipTs(ts);
  }
  function hitAttrs(s, i) {
    var missedOnly = ptIsFailure(s) && thresholdKnown && statusAt(i) !== "down";
    var attrs = ' data-ts="' + escapeHtml(String(s.timestamp)) +
      '" data-rtt="' + (typeof s.responseTimeMs === "number" ? s.responseTimeMs : "") +
      '" data-ok="' + (ptHasResponse(s) ? "1" : "0") +
      '" data-dep="' + (ptIsFailure(s) && ptIsDependency(s) ? "1" : "0") +
      // How many misses were outstanding after this probe, so a hover reads the
      // same running tally the strip's tooltip states rather than only naming
      // the color.
      '" data-missed="' + ((states[i] && states[i].missed) || 0) +
      '" data-miss-only="' + (missedOnly ? "1" : "0") +
      '" data-err="' + escapeHtml(s.error || "") + '"';
    // Rollup buckets carry aggregate stats — surface them in the tooltip so an
    // "Hourly avg"/"Daily avg" point reads as an average + min/max band + the
    // bucket's real packet-loss %, not a single-sample hit.
    if (typeof s.successCount === "number") {
      var lossPct = s.sampleCount ? (s.failureCount / s.sampleCount) * 100 : 0;
      attrs += ' data-rollup="1"' +
        ' data-loss="' + lossPct.toFixed(1) + '"' +
        ' data-min="' + (typeof s.minResponseTimeMs === "number" ? s.minResponseTimeMs : "") + '"' +
        ' data-max="' + (typeof s.maxResponseTimeMs === "number" ? s.maxResponseTimeMs : "") + '"';
    }
    return attrs;
  }
  // Transparent hit targets so hover is forgiving for the 1.5px dots and the
  // baseline failure dots. Successful samples use a 7px circle centered on
  // the dot; failed samples keep a full-height 10px rect centered on the
  // sample's x so the tooltip fires anywhere in that column, not just on the
  // small red dot. Same pattern as the polling-method transition rect above.
  var hitTargets = samples.map(function (s, i) {
    var x = xFor(s.timestamp);
    if (ptHasResponse(s)) {
      return '<circle class="monitor-hit" cx="' + x + '" cy="' + yFor(s.responseTimeMs) + '" r="7" fill="transparent" style="cursor:crosshair"' + hitAttrs(s, i) + '/>';
    }
    return '<rect class="monitor-hit" x="' + (x - 5) + '" y="' + padT + '" width="10" height="' + innerH + '" fill="transparent" style="cursor:crosshair"' + hitAttrs(s, i) + '/>';
  }).join("");

  // Y-axis ticks
  var ticks = "";
  for (var i = 0; i <= 4; i++) {
    var v = (ceil * i / 4);
    var y = padT + innerH - (v / ceil) * innerH;
    ticks +=
      '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="rgba(127,127,127,0.15)"/>' +
      '<text x="' + (padL - 4) + '" y="' + (y + 3) + '" text-anchor="end" font-size="10" fill="currentColor">' + Math.round(v) + '</text>';
    // The loss axis shares the gridlines — quarters of 0–lossCeil land on the
    // same five rows as the ms quarters — so it adds labels, never lines.
    if (hasLoss) {
      ticks += '<text x="' + (W - padR + 4) + '" y="' + (y + 3) + '" text-anchor="start" font-size="10" fill="currentColor">' + (lossCeil * i / 4) + '%</text>';
    }
  }

  // Up here rather than beside the SVG: the loss layer's gradients need it too.
  var clipId = _chartClipId("monitor");

  // The packet-loss layer: a dashed polyline per contiguous run of buckets,
  // broken where buckets are missing (a gap in probing is not 0 % loss), plus a
  // hover target per point. Drawn OVER the response series and its hit targets
  // so a cursor landing on a loss point reads the loss.
  //
  // Each bucket is coloured by the device's VERDICT over it, from the same
  // replay the response line runs: grey while the parent was dark, blue on the
  // climb back, amber/the severity colour for misses, the Up green otherwise —
  // the vocabulary the alert email's loss chart speaks too. The dash is what
  // keeps it apart from the response line where the two cross. A bucket with no
  // primary poll inside it (a long ICMP-only stretch) carries the state the
  // last poll before it left.
  var LOSS_RANK = { up: 0, rec: 1, dep: 2, missed: 3, down: 4 };
  var sampleState = samples.map(function (s, i) {
    if (ptIsFailure(s)) {
      if (ptIsDependency(s)) return "dep";
      return (!thresholdKnown || statusAt(i) === "down") ? "down" : "missed";
    }
    return statusAt(i) === "recovering" ? "rec" : "up";
  });
  var sampleMs = samples.map(function (s) { return new Date(s.timestamp).getTime(); });
  function lossStateColor(st) {
    return st === "rec" ? _CHART_RECOVER_COLOR
      : st === "dep" ? _CHART_DEP_COLOR
      : st === "missed" ? _CHART_MISS_COLOR
      : st === "down" ? downColor
      : _CHART_UP_COLOR;
  }
  var lossStatesDrawn = {};
  var lossDefs = "";
  var lossLayer = "";
  var lossHits = "";
  if (hasLoss) {
    var yLoss = _chartYScale(padT, innerH, 0, lossCeil);
    var lossBucketMs = Number(lossSeries.bucketMs) || 0;
    var si = 0;
    var carried = "up";
    var lossPts = lossPoints.map(function (p) {
      var end = p.t + (lossBucketMs || 1);
      while (si < sampleMs.length && sampleMs[si] < p.t) { carried = sampleState[si]; si++; }
      var best = null;
      for (var k = si; k < sampleMs.length && sampleMs[k] < end; k++) {
        if (best === null || LOSS_RANK[sampleState[k]] > LOSS_RANK[best]) best = sampleState[k];
      }
      var st = best || carried;
      lossStatesDrawn[st] = true;
      return { t: p.t, v: p.v, color: lossStateColor(st) };
    });
    var runs = [];
    var cur = [];
    lossPts.forEach(function (p, i) {
      var prev = i > 0 ? lossPts[i - 1] : null;
      if (prev && lossBucketMs > 0 && (p.t - prev.t) > lossBucketMs * 2.5) { runs.push(cur); cur = []; }
      cur.push(p);
    });
    if (cur.length) runs.push(cur);
    lossLayer = runs.map(function (run, ri) {
      if (run.length === 1) {
        return '<circle cx="' + xFor(run[0].t) + '" cy="' + yLoss(run[0].v) + '" r="2" fill="' + run[0].color + '"/>';
      }
      // One dashed polyline per same-colour stretch, and a fading segment
      // where the state changes — the response line's own treatment.
      var out = "";
      var start = 0;
      for (var j = 1; j <= run.length; j++) {
        if (j < run.length && run[j].color === run[start].color) continue;
        if (j - start > 1) {
          out += '<polyline fill="none" stroke="' + run[start].color + '" stroke-width="1.5" stroke-dasharray="4,3" stroke-linejoin="round" points="' +
            run.slice(start, j).map(function (p) { return xFor(p.t) + ',' + yLoss(p.v); }).join(" ") + '"/>';
        }
        if (j < run.length) {
          var a = run[j - 1], b = run[j];
          var gid = clipId + "-loss-" + ri + "-" + j;
          lossDefs += '<linearGradient id="' + gid + '" gradientUnits="userSpaceOnUse"' +
            ' x1="' + xFor(a.t) + '" y1="' + yLoss(a.v) + '" x2="' + xFor(b.t) + '" y2="' + yLoss(b.v) + '">' +
            '<stop offset="0%" stop-color="' + a.color + '"/><stop offset="100%" stop-color="' + b.color + '"/></linearGradient>';
          out += '<line x1="' + xFor(a.t) + '" y1="' + yLoss(a.v) + '" x2="' + xFor(b.t) + '" y2="' + yLoss(b.v) +
            '" stroke="url(#' + gid + ')" stroke-width="1.5" stroke-dasharray="4,3"/>';
        }
        start = j;
      }
      return out;
    }).join("");
    lossHits = lossPoints.map(function (p) {
      return '<circle class="monitor-loss-hit" cx="' + xFor(p.t) + '" cy="' + yLoss(p.v) + '" r="6" fill="transparent" style="cursor:crosshair"' +
        ' data-ts="' + escapeHtml(String(p.t)) + '" data-loss="' + escapeHtml(String(p.v)) + '"/>';
    }).join("");
  }

  // X-axis tick labels. When the window is ≤24h the time-only label loses the
  // date — render the date underneath the first tick and any tick whose day
  // differs from the previous one, so a window that crosses midnight is
  // unambiguous.
  var xTicks = _chartXTicksSVG(t0, t1, padL, padT, innerW, innerH, { dateLine: spanMs <= oneDayMs });

  // Axis titles
  var yTitleX = 14;
  var yTitleY = padT + innerH / 2;
  var yTitle = '<text class="chart-axis-title" x="' + yTitleX + '" y="' + yTitleY + '" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.85" transform="rotate(-90 ' + yTitleX + ' ' + yTitleY + ')">Response time (ms)</text>';
  if (hasLoss) {
    var y2TitleX = W - 8;
    yTitle += '<text class="chart-axis-title" x="' + y2TitleX + '" y="' + yTitleY + '" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.85" transform="rotate(90 ' + y2TitleX + ' ' + yTitleY + ')">Packet loss (%)</text>';
  }
  var xTitle = '<text class="chart-axis-title" x="' + (padL + innerW / 2) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.85">Time</text>';

  // Polling-method transition markers — vertical amber dashed lines at
  // events where any *Polling field or monitorCredentialId changed. Filter
  // to within the chart window so off-screen transitions
  // don't smear at the edges. A hit-target rectangle around each line
  // makes the hover forgiving without tying tooltip behaviour to the 1.5px
  // stroke. Tooltip text comes from the marker's data-label.
  var transitionLayer = transitions
    .map(function (m) { return { ts: new Date(m.timestamp).getTime(), label: m.label, raw: m.timestamp }; })
    .filter(function (m) { return m.ts >= t0 && m.ts <= t1; })
    .map(function (m) {
      var x = xFor(m.raw);
      return '<line x1="' + x + '" y1="' + padT + '" x2="' + x + '" y2="' + (padT + innerH) + '" stroke="rgba(255,193,7,0.55)" stroke-width="1.5" stroke-dasharray="3,3"/>' +
        '<circle cx="' + x + '" cy="' + (padT - 2) + '" r="3" fill="rgba(255,193,7,0.9)" stroke="rgba(0,0,0,0.3)" stroke-width="0.5"/>' +
        '<rect class="monitor-transition" x="' + (x - 5) + '" y="' + padT + '" width="10" height="' + innerH + '" fill="transparent" style="cursor:help"' +
          ' data-ts="' + escapeHtml(String(m.raw)) + '" data-label="' + escapeHtml(m.label) + '"/>';
    }).join("");

  var line = _failureAwareSeriesSVG(linePts, _CHART_UP_COLOR, clipId);
  var maintLayer = _maintenanceBandLayer(t0, t1, padL, padT, innerW, innerH);
  var svg =
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      _chartClipDefs(clipId, padL, padT, innerW, innerH) +
      '<defs>' + line.defs + lossDefs + '</defs>' +
      ticks +
      xTicks +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
      maintLayer +
      transitionLayer +
      yTitle +
      xTitle +
      '<g ' + _chartClipAttr(clipId) + '>' +
        (showMax ? _maxLineSVG(maxPts, _CHART_UP_COLOR) : "") +
        line.segments +
        // Drawn from linePts, not `oks`: same points, but these carry the
        // `rec` flag, so a dot on the climb back out is purple like its segment
        // instead of a green dot sitting on a purple line.
        linePts.filter(function (p) { return p.ok; }).map(function (p) {
          return '<circle cx="' + p.x + '" cy="' + p.y + '" r="1.5" fill="' + _chartPointColor(p, _CHART_UP_COLOR) + '"/>';
        }).join("") +
        _failureDotsSVG(linePts) +
        hitTargets +
        lossLayer +
        lossHits +
      '</g>' +
    '</svg>' +
    '<div class="monitor-tooltip" style="position:absolute;pointer-events:none;display:none;background:var(--color-bg-primary);border:1px solid var(--color-border);border-radius:4px;padding:6px 8px;font-size:0.75rem;line-height:1.35;color:var(--color-text-primary);box-shadow:0 4px 12px rgba(0,0,0,0.25);white-space:nowrap;z-index:5"></div>';
  container.innerHTML = svg;
  container.style.alignItems = "stretch";
  container.style.justifyContent = "flex-start";
  container.style.position = "relative";
  _stashChartGeometry(container, t0, t1, padL, innerW, W);

  // The key: the states the response line and the loss line actually drew, in
  // the Status pill's order, then the marks that are not states. A chart that
  // drew nothing but Up gets no key — the title already says what it is.
  if (legendSlot) {
    var drawn = {};
    for (var st in lossStatesDrawn) drawn[st] = true;
    linePts.forEach(function (p) {
      if (p.ok) drawn[p.rec ? "rec" : "up"] = true;
      else drawn[p.dep ? "dep" : p.down === false ? "missed" : "down"] = true;
    });
    var keyEntries = [];
    [["up", "Up"], ["missed", "Missed poll"], ["down", "Down"], ["rec", "Recovering"], ["dep", "Parent down"]].forEach(function (e) {
      if (drawn[e[0]]) keyEntries.push({ label: e[1], color: lossStateColor(e[0]), style: "line" });
    });
    if (hasLoss) keyEntries.push({ label: "Packet loss (right axis)", color: "var(--color-text-secondary)", style: "dash" });
    if (maintLayer) keyEntries.push({ label: "Maintenance", color: "rgba(149,117,205,0.14)", border: "rgba(149,117,205,0.45)", style: "band" });
    if (transitionLayer) keyEntries.push({ label: "Polling change", color: "rgba(255,193,7,0.9)", style: "dash" });
    var onlyUp = keyEntries.length === 1 && keyEntries[0].label === "Up";
    // The Max chip rides the key row on a rollup tier, so the row exists even
    // when the chart drew nothing but Up.
    legendSlot.innerHTML = _chartStateLegendHTML(onlyUp ? [] : keyEntries,
      rollupTier ? _maxLineChipHTML("assetMonitor", rollupTier, showMax, _CHART_UP_COLOR) : "");
    _wireMaxLineChip(legendSlot, "assetMonitor", function () { _renderMonitorChart(container, data, transitions); });
  }

  var tip = container.querySelector(".monitor-tooltip");
  var svgEl = container.querySelector("svg");
  function positionTip(evt) {
    var rect = container.getBoundingClientRect();
    var x = evt.clientX - rect.left + 12;
    var y = evt.clientY - rect.top + 12;
    var tw = tip.offsetWidth, th = tip.offsetHeight;
    if (x + tw > container.clientWidth - 4) x = evt.clientX - rect.left - tw - 12;
    if (y + th > container.clientHeight - 4) y = evt.clientY - rect.top - th - 12;
    if (x < 4) x = 4;
    if (y < 4) y = 4;
    tip.style.left = x + "px";
    tip.style.top = y + "px";
  }
  function showTip(target, evt) {
    var ts = target.getAttribute("data-ts");
    var rtt = target.getAttribute("data-rtt");
    var ok = target.getAttribute("data-ok") === "1";
    var err = target.getAttribute("data-err");
    var dep = target.getAttribute("data-dep") === "1";
    var missOnly = target.getAttribute("data-miss-only") === "1";
    var missedN = Number(target.getAttribute("data-missed") || 0);
    // Three ways a probe can fail and three things to say about it. A miss the
    // upstream explains is grey — the probe did fail, but nothing about THIS
    // device is in question. A miss that has not reached the covering
    // automation's count is amber and says how many are outstanding, so a hover
    // reads as the same running tally the strip above reports. Only a miss that
    // IS the verdict is red.
    var danger = dep
      ? 'style="color:' + _CHART_DEP_COLOR + '"'
      : missOnly
        ? 'style="color:' + _CHART_MISS_COLOR + '"'
        : 'style="color:var(--color-danger,#d32f2f)"';
    var missText = dep
      ? "dependency down"
      : missOnly
        ? "missed poll — " + missedN + " outstanding"
        : "no response · Down";
    if (target.getAttribute("data-rollup") === "1") {
      // Aggregated bucket: avg AND max (whether or not the max line is
      // shown, so a huge peak never hides the average reading), the min, and
      // the bucket's packet-loss %.
      var mn = target.getAttribute("data-min");
      var mx = target.getAttribute("data-max");
      var loss = parseFloat(target.getAttribute("data-loss") || "0");
      var rRttLine = ok && rtt !== "" ? _avgMaxText(rtt + " ms", mx !== "" ? mx + " ms" : null) : '<span ' + danger + '>' + missText + '</span>';
      var rLossLine = loss > 0 ? '<span ' + danger + '>' + loss.toFixed(1) + '%</span>' : '0%';
      tip.innerHTML =
        '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(fmtTooltipTs(ts)) + '</div>' +
        '<div>Response: ' + rRttLine + '</div>' +
        (ok && mn !== "" ? '<div>Min: ' + escapeHtml(mn) + ' ms</div>' : '') +
        '<div>Missed polls: ' + rLossLine + '</div>';
      tip.style.display = "block";
      positionTip(evt);
      return;
    }
    var rttLine = ok && rtt !== "" ? (escapeHtml(rtt) + " ms") : '<span ' + danger + '>' + missText + '</span>';
    var lossLine = ok ? "no" : '<span ' + danger + '>yes' + (dep ? " (upstream down)" : "") + '</span>';
    var errLine = !ok && err ? '<div style="color:var(--color-text-secondary);margin-top:2px">' + escapeHtml(err) + '</div>' : '';
    tip.innerHTML =
      '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(fmtTooltipTs(ts)) + '</div>' +
      '<div>Response: ' + rttLine + '</div>' +
      '<div>Missed poll: ' + lossLine + '</div>' +
      errLine;
    tip.style.display = "block";
    positionTip(evt);
  }
  // Hover tooltip for a packet-loss point: the bucket's loss and how wide the
  // bucket is, since on a long window one point covers many probes.
  function showLossTip(target, evt) {
    var ts = Number(target.getAttribute("data-ts"));
    var v = parseFloat(target.getAttribute("data-loss") || "0");
    var bMs = Number(lossSeries && lossSeries.bucketMs) || 0;
    var span = bMs >= 86400000 ? Math.round(bMs / 86400000) + "-day"
      : bMs >= 3600000 ? Math.round(bMs / 3600000) + "-hour"
      : bMs > 0 ? Math.round(bMs / 60000) + "-min" : "";
    tip.innerHTML =
      '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(fmtTooltipTs(ts)) + '</div>' +
      '<div>Packet loss: <span style="font-weight:600">' + v.toFixed(1) + '%</span></div>' +
      (span ? '<div style="color:var(--color-text-secondary)">' + span + ' bucket, all probes</div>' : '');
    tip.style.display = "block";
    positionTip(evt);
  }
  // Hover tooltip for the amber polling-method transition lines.
  // Multiline labels render with each transition on its own line.
  function showTransitionTip(target, evt) {
    var ts    = target.getAttribute("data-ts");
    var label = target.getAttribute("data-label") || "";
    var lines = label.split("\n").map(function (l) {
      return '<div>' + escapeHtml(l) + '</div>';
    }).join("");
    tip.innerHTML =
      '<div style="font-weight:600;margin-bottom:2px;color:#ffc107">⚙ Polling change</div>' +
      '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(fmtTooltipTs(ts)) + '</div>' +
      lines;
    tip.style.display = "block";
    positionTip(evt);
  }
  svgEl.addEventListener("mousemove", function (evt) {
    var t = evt.target;
    if (!t || !t.classList) { tip.style.display = "none"; return; }
    // Transition rect takes priority — operators investigating intermittency
    // want to see the polling-method change first when their cursor lands on
    // both a sample dot and a transition line.
    if (t.classList.contains("monitor-transition")) {
      showTransitionTip(t, evt);
    } else if (t.classList.contains("monitor-loss-hit")) {
      showLossTip(t, evt);
    } else if (t.classList.contains("monitor-hit")) {
      showTip(t, evt);
    } else {
      tip.style.display = "none";
    }
  });
  svgEl.addEventListener("mouseleave", function () { tip.style.display = "none"; });
  _addChartScreenshotButton(container, "Response time", {
    yAxis: "Response time (ms)",
    getStats: _statsSummaryFrom("asset-monitor-stats"),
  });
  // Pass `transitions` through the resize closure — without it a container
  // resize silently dropped the polling-transition markers (and would drop
  // the maintenance bands' companion overlay context).
  _observeChartResize(container, function (c) { _renderMonitorChart(c, data, transitions); });
}
