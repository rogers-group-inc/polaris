// public/js/asset-shared.js
//
// The pure asset-detail helpers the desktop slide-over (public/js/assets.js)
// and the phone's asset sheet (public/js/mobile/asset-detail.js) both need.
// The phone does not load assets.js (it is ~1.6 MB), so each of these used to
// live twice with a "change one, change both" comment — and several pairs had
// drifted. One copy now, loaded by mobile.html and by every desktop page that
// loads assets.js, BEFORE it (tests/unit/assetSharedModules.test.ts guards
// the script order).
//
// Rules for what belongs here: pure functions and constants only — no DOM, no
// page globals beyond the ones api.js puts on every page (`timeAgo`). Markup
// stays with the surface that draws it: a helper here returns words, numbers,
// a verdict or a data structure, and each page turns that into its own HTML.

(function () {
  // "45s" / "12m" / "3h 04m". FortiOS reports an ARP entry's age in seconds;
  // anything non-numeric is absent rather than zero (null → the caller's dash).
  function arpAgeLabel(sec) {
    if (typeof sec !== "number" || !isFinite(sec) || sec < 0) return null;
    if (sec < 60) return Math.round(sec) + "s";
    if (sec < 3600) return Math.floor(sec / 60) + "m";
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    return h + "h " + String(m).padStart(2, "0") + "m";
  }

  // An IPsec connection that is a person (FortiClient over IPsec or SSL-VPN)
  // rather than a site peer.
  function ipsecIsRemoteAccess(c) {
    return c.kind === "remote-access" || c.kind === "ssl-vpn";
  }

  // "3d 04h" / "5h 12m" / "40m" — how long a connection has been up. Null when
  // the source gave no start time (both surfaces render that as nothing).
  function ipsecUptimeLabel(since) {
    if (!since) return null;
    var sec = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000));
    if (sec < 3600) return Math.max(1, Math.floor(sec / 60)) + "m";
    if (sec < 86400) return Math.floor(sec / 3600) + "h " + String(Math.floor((sec % 3600) / 60)).padStart(2, "0") + "m";
    return Math.floor(sec / 86400) + "d " + String(Math.floor((sec % 86400) / 3600)).padStart(2, "0") + "h";
  }

  // Partial match for every child-table filter box (ARP, MAC table, Wireless,
  // a gate's child wireless / MAC tables). Plain substring over every field,
  // so a middle fragment of an IP ("41.30") or a colon-separated MAC ("a0:12")
  // hits; MAC fields are ALSO compared with separators stripped from both
  // sides, so "a012", "a0-12" and "a0.12" (Cisco-style dotted) find
  // AA:BB:A0:12:… too. That separator-free match must START ON AN OCTET (an
  // even offset): without the rule "a0" would hit BA:01 through "ba01", which
  // no one typing a0 means. `filter` is already lower-cased.
  function childFilterMatches(textParts, macParts, filter) {
    if (!filter) return true;
    if (textParts.concat(macParts).join(" ").toLowerCase().indexOf(filter) !== -1) return true;
    var compact = filter.replace(/[\s:.\-]/g, "");
    if (compact.length < 2 || !/^[0-9a-f]+$/.test(compact)) return false;
    return macParts.some(function (m) {
      if (!m) return false;
      var hex = String(m).toLowerCase().replace(/[:.\-]/g, "");
      for (var at = hex.indexOf(compact); at !== -1; at = hex.indexOf(compact, at + 1)) {
        if (at % 2 === 0) return true;
      }
      return false;
    });
  }

  /**
   * Attach each wireless station to the SSID it is actually on.
   *
   * BSSID first: it is the per-VAP radio address the client associated with,
   * so it identifies one SSID on one radio exactly. The (radio, SSID-name) pair
   * is the fallback for sources that publish no BSSID. A station's own
   * `wlanId` is deliberately NOT used — it is only as trustworthy as the
   * source's VAP numbering, and getting it wrong files a client under someone
   * else's SSID.
   *
   * Anything left over is returned rather than dropped: a client Polaris
   * cannot file is still a client, and hiding it would make the tree quietly
   * disagree with the station count.
   */
  function buildWirelessTree(radios, stations) {
    var byBssid = {}, byRadioSsid = {};
    var nodes = radios.map(function (r) {
      var vapNodes = (r.vaps || []).map(function (v) {
        var node = { vap: v, stations: [] };
        if (v.bssid) byBssid[String(v.bssid).toUpperCase()] = node;
        if (v.ssid)  byRadioSsid[r.radioIndex + "\u0000" + String(v.ssid).toLowerCase()] = node;
        return node;
      });
      return { radio: r, vaps: vapNodes };
    });

    var unplaced = [];
    stations.forEach(function (s) {
      var node = s.bssid ? byBssid[String(s.bssid).toUpperCase()] : null;
      if (!node && s.radioId != null && s.ssid) {
        node = byRadioSsid[s.radioId + "\u0000" + String(s.ssid).toLowerCase()];
      }
      if (node) node.stations.push(s);
      else unplaced.push(s);
    });
    return { radios: nodes, unplaced: unplaced };
  }

  // ─── Booked firmware upgrades / reboots (business rule 93) ────────────────

  /** "YYYY-MM-DDTHH:MM" in the browser's zone — a datetime-local input's value. */
  function fwLocalInputValue(d) {
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  /**
   * "Tue, Oct 7, 2026, 2:00 AM CDT (in 9 h)" — a booking as the reader's clock
   * shows it. The year and the zone name are part of it on EVERY surface: a
   * booking is an absolute instant the server fires on, and the phone is the
   * surface most likely to be read from another zone (the phone copy had
   * dropped both until 2026-11-06).
   */
  function fwWhenText(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var txt = d.toLocaleString(undefined, Object.assign({ weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" },
      typeof timeZoneOpts === "function" ? timeZoneOpts() : {}));
    var mins = Math.round((d.getTime() - Date.now()) / 60000);
    var rel = mins <= 0 ? "due now"
      : mins < 60 ? "in " + mins + " min"
      : mins < 48 * 60 ? "in " + Math.round(mins / 60) + " h"
      : "in " + Math.round(mins / 1440) + " days";
    return txt + " (" + rel + ")";
  }

  // The notify-recipient box: commas, semicolons, spaces or newlines.
  function fwParseEmails(text) {
    return String(text || "").split(/[\s,;]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  // ─── Storage pools (Unraid / TrueNAS / Proxmox) ───────────────────────────

  // A pool's / group's / drive's health word as the platform reports it (ZFS
  // ONLINE / DEGRADED / FAULTED…, Unraid's array state STARTED / STOPPED, a
  // disk's DISK_OK…, a SMART verdict) → "good" | "bad" | "neutral". Unknown
  // words stay neutral. Each surface paints the verdict its own way.
  function storageHealthState(h) {
    var s = String(h == null ? "" : h).toUpperCase();
    if (/^(ONLINE|HEALTHY|STARTED|DISK_OK|OK|PASSED)$/.test(s)) return "good";
    if (/(FAULT|UNAVAIL|REMOVED|OFFLINE|DEGRADED|FAIL|INVALID|DSBL|WRONG|STOPPED)/.test(s)) return "bad";
    return "neutral";
  }

  // A pool member (a drive) that needs attention: any read / write / checksum
  // error, a health word outside the healthy set, or a failing SMART verdict.
  function poolMemberUnhealthy(m) {
    var errs = (m.readErrors || 0) + (m.writeErrors || 0) + (m.checksumErrors || 0) + (m.errors || 0);
    var h = String(m.health || "").toUpperCase();
    return errs > 0 || (h !== "" && !/^(ONLINE|DISK_OK|AVAIL|INUSE)$/.test(h)) ||
      (!!m.smart && !/^(OK|PASSED|UNKNOWN)$/i.test(m.smart));
  }

  // "Scrub: finished 3 days ago, 0 errors" — the last scrub / resilver /
  // parity check. `timeAgo` is api.js's, on every page.
  function poolScanText(scan) {
    if (!scan) return "";
    var kind = scan.kind === "parity-check" ? "Parity check" : scan.kind === "resilver" ? "Resilver" : scan.kind === "scrub" ? "Scrub" : (scan.kind || "Scan");
    var when = scan.at ? " " + (scan.state === "running" ? "started " : "") + timeAgo(scan.at) : "";
    var state = scan.state === "running"
      ? "running" + (scan.percent != null ? " (" + Number(scan.percent).toFixed(1) + "%)" : "")
      : (scan.state || "—");
    var errs = scan.errors != null ? ", " + scan.errors + " error" + (scan.errors === 1 ? "" : "s") : "";
    return kind + ": " + state + when + errs;
  }

  // ─── SD-WAN ───────────────────────────────────────────────────────────────

  // One colour per WAN member, by its position in the gate's member list, so a
  // member reads the same colour on every chart and on both surfaces.
  var SDWAN_MEMBER_COLORS = ["#2a9d8f", "#4361ee", "#f4a261", "#9b5de5", "#e76f51", "#43aa8b", "#577590", "#bc6c25"];
  function sdwanMemberColor(name, members) {
    if (!name) return "#7b8794";
    var idx = (members || []).indexOf(name);
    if (idx < 0) idx = 0;
    return SDWAN_MEMBER_COLORS[idx % SDWAN_MEMBER_COLORS.length];
  }

  window.PolarisAssetShared = {
    arpAgeLabel: arpAgeLabel,
    ipsecIsRemoteAccess: ipsecIsRemoteAccess,
    ipsecUptimeLabel: ipsecUptimeLabel,
    childFilterMatches: childFilterMatches,
    buildWirelessTree: buildWirelessTree,
    fwLocalInputValue: fwLocalInputValue,
    fwWhenText: fwWhenText,
    fwParseEmails: fwParseEmails,
    storageHealthState: storageHealthState,
    poolMemberUnhealthy: poolMemberUnhealthy,
    poolScanText: poolScanText,
    SDWAN_MEMBER_COLORS: SDWAN_MEMBER_COLORS,
    sdwanMemberColor: sdwanMemberColor,
  };
})();
