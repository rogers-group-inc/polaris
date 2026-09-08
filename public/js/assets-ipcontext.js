/**
 * public/js/assets-ipcontext.js
 *
 * The IP cross-reference panel under the Add Asset form's IP Address field.
 *
 * Manually adding an asset is the one create path with no discovery behind it,
 * so everything Polaris knows about the address the operator is typing sits in
 * tables the form never consulted: the containing network and the FortiGate
 * serving its DHCP, the lease or reservation already on the address, the gate
 * ARP caches and sightings that have resolved it, the switch port its MAC
 * shows up on, and any asset already carrying it. One debounced call to
 * GET /assets/ip-context answers all of it (services/ipContextService.ts).
 *
 * Two things it deliberately does NOT do:
 *
 *   - It never writes. The panel reports; the operator decides. "Use these
 *     details" fills form fields client-side and nothing more.
 *   - It never overwrites what the operator already typed. `applicableSuggestions`
 *     offers a field only when that field is currently blank, and coordinates
 *     only when BOTH are blank — getAssetFormData treats lat/long as a pair and
 *     rejects a half-filled one, so suggesting into half of it would turn a
 *     helper into a save error.
 *
 * The pure halves (`buildFindings`, `applicableSuggestions`, `suggestionLabels`)
 * are exposed on window.PolarisIpContext for the happy-dom unit suite.
 *
 * Depends on globals from api.js (api / escapeHtml / timeAgo). Loaded on
 * assets.html after assets.js.
 */

/* global api, escapeHtml, timeAgo */

(function () {
  "use strict";

  // Debounce long enough that typing an address end-to-end costs one call, and
  // short enough that pasting one answers immediately.
  var LOOKUP_DEBOUNCE_MS = 400;

  // ── Pure: findings ────────────────────────────────────────────────────────

  function relTime(v) {
    if (!v) return "";
    try { return timeAgo(v); } catch (e) { return ""; }
  }

  // How the reservation row describes itself. sourceType answers "who owns
  // this address" and dhcpBinding "how the gate hands it out" (business rule
  // 23) — the pair is why a FortiAP row can read "owned by the AP, leased
  // dynamically", which is exactly the state an operator needs to see before
  // claiming the address.
  var SOURCE_WORDS = {
    manual:            "a manual reservation",
    dhcp_reservation:  "a DHCP reservation",
    dhcp_lease:        "an active DHCP lease",
    interface_ip:      "a FortiGate interface address",
    vip:               "a VIP",
    fortiswitch:       "a managed FortiSwitch",
    fortinap:          "a managed FortiAP",
    fortimanager:      "FortiManager",
    fortigate:         "a FortiGate",
    dns_resolved:      "a DNS-resolved record",
  };

  function reservationText(r) {
    var what = SOURCE_WORDS[r.sourceType] || r.sourceType;
    var bits = ["In use by " + what];
    if (r.hostname) bits.push('as "' + r.hostname + '"');
    if (r.macAddress) bits.push("(" + r.macAddress + ")");
    var tail = [];
    if (r.dhcpBinding === "lease") tail.push("the gate leases it dynamically — no reserved-address entry");
    else if (r.dhcpBinding === "reservation") tail.push("a MAC-to-IP entry exists on the gate");
    if (r.owner) tail.push("owner " + r.owner);
    var seen = r.lastSeenLeased || r.lastSeenArp;
    if (seen) tail.push("last seen " + relTime(seen));
    return bits.join(" ") + (tail.length ? ". " + tail.join("; ") + "." : ".");
  }

  // Which of the three gate sources answered, in the operator's terms. The
  // distinction matters: an ARP hit means the gate resolved this exact address
  // minutes ago, while the subnet path is config truth that holds even for an
  // address nothing has ever seen.
  function firewallText(ctx) {
    var fw = ctx.firewall;
    var name = (fw.asset && fw.asset.hostname) || fw.deviceName;
    var why;
    if (fw.source === "arp") {
      var a = (ctx.arp || [])[0] || {};
      why = "its ARP table resolves this address" +
        (a.ifName ? " on " + a.ifName : "") +
        (a.lastSeen ? ", " + relTime(a.lastSeen) : "");
    } else if (fw.source === "subnet") {
      why = "it serves DHCP for this network";
    } else {
      why = "a device was last sighted at this address behind it";
    }
    var extra = [];
    if (fw.asset) {
      var loc = fw.asset.location || fw.asset.learnedLocation;
      if (loc) extra.push(loc);
    } else {
      extra.push("no matching firewall asset in inventory");
    }
    return "Behind " + name + " — " + why + "." + (extra.length ? " " + extra.join(" · ") : "");
  }

  /**
   * Turn a context payload into the ordered list the panel renders.
   *
   * Level drives colour only: "warn" is reserved for the two findings that
   * should stop an operator mid-form — the address already belongs to an
   * asset, or it is already spoken for in IPAM.
   */
  function buildFindings(ctx) {
    if (!ctx || ctx.unparseable) return [];
    var out = [];

    // Already an asset. First, and warn-level when it is that asset's PRIMARY
    // address — that is a duplicate about to be created, not a coincidence.
    (ctx.existingAssets || []).forEach(function (a) {
      out.push({
        kind: "asset",
        level: a.primary ? "warn" : "info",
        label: "Already in inventory",
        text: (a.hostname || "(no hostname)") + " (" + a.assetType + ", " + a.status + ") " +
          (a.primary ? "already has this as its primary IP." : "lists this among its other addresses."),
        assetId: a.id,
      });
    });

    if (ctx.subnet) {
      var s = ctx.subnet;
      var net = s.cidr + (s.name ? " · " + s.name : "");
      var detail = [];
      if (s.vlan != null) detail.push("VLAN " + s.vlan);
      if (s.block) detail.push("block " + s.block.name + " (" + s.block.cidr + ")");
      if (s.status && s.status !== "available") detail.push(s.status);
      if (s.integration) detail.push("discovered by " + s.integration.name);
      out.push({
        kind: "subnet", level: "info", label: "Network",
        text: net + (detail.length ? " — " + detail.join(" · ") : ""),
        subnetId: s.id,
      });
    } else if (ctx.visibility && ctx.visibility.subnets) {
      out.push({
        kind: "subnet", level: "info", label: "Network",
        text: "No network on record contains this address.",
      });
    }

    if (ctx.firewall) {
      out.push({ kind: "firewall", level: "info", label: "Firewall", text: firewallText(ctx) });
    }

    if (ctx.reservation) {
      out.push({
        kind: "reservation", level: "warn", label: "IP in use",
        text: reservationText(ctx.reservation),
      });
    } else if (ctx.visibility && ctx.visibility.reservations && ctx.subnet) {
      out.push({
        kind: "reservation", level: "info", label: "IP status",
        text: "Free — no active lease or reservation in " + ctx.subnet.cidr + ".",
      });
    }

    // The switch port the resolved MAC shows up on. Only ever present when
    // something already supplied a MAC, so it is additive detail, never the
    // only finding.
    (ctx.switchPorts || []).slice(0, 3).forEach(function (p) {
      var sw = p.switchAsset ? (p.switchAsset.hostname || "a switch") : "a switch";
      out.push({
        kind: "port", level: "info", label: "Switch port",
        text: sw + (p.ifName ? " " + p.ifName : "") +
          (p.vlanId != null ? " (VLAN " + p.vlanId + ")" : "") +
          " has learned " + p.macAddress + " — " + relTime(p.lastSeen) + ".",
        assetId: p.switchAsset ? p.switchAsset.id : null,
      });
    });

    // The access point a wireless station on this address is associated to.
    // Reached by the resolved MAC or by the address the AP itself recorded, so
    // unlike the switch-port line it can answer with no MAC known at all.
    (ctx.apStations || []).slice(0, 3).forEach(function (s) {
      var ap = s.apAsset ? (s.apAsset.hostname || "an access point") : "an access point";
      var via = s.matchedBy === "ip" ? " reports this address for " : " has station ";
      out.push({
        kind: "ap", level: "info", label: "Wireless AP",
        text: ap + via + s.macAddress +
          (s.ssid ? " on " + s.ssid : "") +
          (s.band ? " (" + s.band + ")" : "") +
          " — " + relTime(s.lastSeen) + ".",
        assetId: s.apAsset ? s.apAsset.id : null,
      });
    });

    // Sightings only when they add a gate the firewall line didn't already
    // name — otherwise it is the same fact twice.
    var namedGate = ctx.firewall ? ctx.firewall.deviceName : null;
    var extraSightings = (ctx.sightings || []).filter(function (s) {
      return s.fortigateDevice !== namedGate;
    }).slice(0, 3);
    extraSightings.forEach(function (s) {
      out.push({
        kind: "sighting", level: "info", label: "Also seen behind",
        text: s.fortigateDevice + " (" + s.source + ")" +
          (s.asset ? " as " + (s.asset.hostname || s.asset.assetType) : "") +
          " — " + relTime(s.lastSeen) + ".",
      });
    });

    if (ctx.visibility && !ctx.visibility.subnets) {
      out.push({
        kind: "hidden", level: "info", label: "Network",
        text: "Not shown — your role cannot read networks.",
      });
    }
    if (ctx.visibility && !ctx.visibility.reservations) {
      out.push({
        kind: "hidden", level: "info", label: "IP status",
        text: "Not shown — your role cannot read reservations.",
      });
    }

    return out;
  }

  // ── Pure: suggestions ─────────────────────────────────────────────────────

  var SUGGESTION_LABELS = {
    hostname:   "Hostname",
    macAddress: "MAC Address",
    location:   "Location",
    latitude:   "Latitude",
    longitude:  "Longitude",
  };

  function blank(v) {
    return v == null || String(v).trim() === "";
  }

  /**
   * The subset of the server's suggestions that would actually fill something
   * in. A field the operator has already typed is never offered — the panel
   * assists a form it does not own.
   *
   * Coordinates are all-or-nothing: getAssetFormData refuses a half-filled
   * lat/long pair, so a suggestion that filled one of them would leave the
   * form unsaveable.
   */
  function applicableSuggestions(ctx, current) {
    var s = (ctx && ctx.suggestions) || {};
    var cur = current || {};
    var out = {};
    ["hostname", "macAddress", "location"].forEach(function (k) {
      if (!blank(s[k]) && blank(cur[k])) out[k] = s[k];
    });
    if (s.latitude != null && s.longitude != null && blank(cur.latitude) && blank(cur.longitude)) {
      out.latitude = s.latitude;
      out.longitude = s.longitude;
    }
    return out;
  }

  /** Field labels for the apply button's "fills X, Y and Z" line. */
  function suggestionLabels(applicable) {
    var keys = Object.keys(applicable || {});
    // Latitude + Longitude always travel together; name them once.
    var hasCoords = keys.indexOf("latitude") >= 0;
    var labels = keys
      .filter(function (k) { return k !== "latitude" && k !== "longitude"; })
      .map(function (k) { return SUGGESTION_LABELS[k] || k; });
    if (hasCoords) labels.push("Coordinates");
    return labels;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function panelHTML(id) {
    return '<div class="ipctx" id="' + id + '" style="display:none"></div>';
  }

  function findingsHTML(findings) {
    return findings.map(function (f) {
      var color = f.level === "warn" ? "var(--color-warning)" : "var(--color-text-secondary)";
      return '<div style="display:flex;gap:8px;line-height:1.45;margin-bottom:2px">' +
        '<span style="flex:0 0 108px;color:var(--color-text-tertiary);font-size:0.72rem;' +
          'text-transform:uppercase;letter-spacing:0.5px;padding-top:1px">' +
          escapeHtml(f.label) + '</span>' +
        '<span style="flex:1;color:' + color + '">' + escapeHtml(f.text) + '</span>' +
      '</div>';
    }).join("");
  }

  function shellHTML(inner) {
    return '<div style="border:1px solid var(--color-border);border-radius:6px;padding:8px 10px;' +
      'margin-top:-0.35rem;margin-bottom:0.75rem;font-size:0.8rem;' +
      'background:var(--color-bg-tertiary)">' + inner + '</div>';
  }

  // ── Mount ─────────────────────────────────────────────────────────────────

  /**
   * Wire the panel to an IP input.
   *
   * `readForm` returns the form's current values for the suggestible fields and
   * `applyValues` writes them back — both injected so this module needs no
   * knowledge of the Add Asset form's element ids, and so the unit suite can
   * drive it with plain objects.
   */
  function mount(opts) {
    var input = document.getElementById(opts.inputId);
    var panel = document.getElementById(opts.panelId);
    if (!input || !panel) return;

    var timer = null;
    var seq = 0;          // request sequence — a slow answer to an older value never paints
    var lastCtx = null;

    function paint(html) {
      if (!html) { panel.style.display = "none"; panel.innerHTML = ""; return; }
      panel.style.display = "";
      panel.innerHTML = shellHTML(html);
    }

    function render() {
      if (!lastCtx) { paint(""); return; }
      var findings = buildFindings(lastCtx);
      if (findings.length === 0) {
        paint('<span style="color:var(--color-text-tertiary)">Nothing on record for ' +
          escapeHtml(lastCtx.ip) + '.</span>');
        return;
      }
      var applicable = applicableSuggestions(lastCtx, opts.readForm ? opts.readForm() : {});
      var labels = suggestionLabels(applicable);
      var apply = labels.length
        ? '<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--color-border)">' +
            '<button type="button" class="btn btn-secondary btn-sm" id="' + opts.panelId + '-apply">' +
              'Use these details</button> ' +
            '<span style="color:var(--color-text-tertiary)">fills ' +
              escapeHtml(labels.join(", ")) + '</span>' +
          '</div>'
        : "";
      paint(findingsHTML(findings) + apply);
      var btn = document.getElementById(opts.panelId + "-apply");
      if (btn) {
        btn.addEventListener("click", function () {
          if (opts.applyValues) opts.applyValues(applicable);
          render();   // re-render: the applied fields are no longer blank, so the offer shrinks
        });
      }
    }

    async function lookup(ip) {
      var mine = ++seq;
      panel.style.display = "";
      panel.innerHTML = shellHTML('<span style="color:var(--color-text-tertiary)">Checking ' +
        escapeHtml(ip) + ' against networks, leases and reservations…</span>');
      var ctx;
      try {
        ctx = await api.assets.ipContext(ip);
      } catch (err) {
        if (mine !== seq) return;
        // A failed lookup is never a reason to block the form — say so quietly
        // and let the operator carry on typing.
        paint('<span style="color:var(--color-text-tertiary)">Could not check this address: ' +
          escapeHtml((err && err.message) || "lookup failed") + '</span>');
        return;
      }
      if (mine !== seq) return;
      lastCtx = ctx && !ctx.unparseable ? ctx : null;
      render();
    }

    input.addEventListener("input", function () {
      if (timer) clearTimeout(timer);
      var raw = input.value.trim();
      // Bail on anything not yet address-shaped rather than round-tripping per
      // keystroke. The server re-validates; this only avoids the traffic.
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(raw) && raw.indexOf(":") < 0) {
        seq++; lastCtx = null; paint("");
        return;
      }
      timer = setTimeout(function () { lookup(raw); }, LOOKUP_DEBOUNCE_MS);
    });

    // An address prefilled before wiring (duplicate-from-existing flows) gets
    // looked up straight away — the operator never types, so no input fires.
    var initial = input.value.trim();
    if (initial) lookup(initial);
  }

  window.PolarisIpContext = {
    panelHTML: panelHTML,
    mount: mount,
    // Pure helpers, exposed for the unit suite.
    buildFindings: buildFindings,
    applicableSuggestions: applicableSuggestions,
    suggestionLabels: suggestionLabels,
  };
})();
