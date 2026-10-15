/**
 * public/js/ipam.js — orchestrator for the IPAM tabbed page.
 *
 * IPAM merges the legacy /blocks.html and /subnets.html pages into a single
 * surface with two tabs. The two tab markups share several DOM IDs
 * (filter-pagesize, pagination, pagination-top), so only ONE tab's content
 * is mounted at a time. Switching tabs unmounts the active tab's nodes and
 * clones the other template into the mount point.
 *
 * Hash routing:
 *   #tab=blocks
 *   #tab=networks
 *   #tab=networks&block=<id>
 *   #tab=networks&subnet=<id>[&focusReservation=<id>]
 *
 * Defaults to the Networks tab when no hash is present.
 *
 * blocks.js / subnets.js expose init() via window.PolarisBlocks /
 * window.PolarisSubnets and skip their own DOMContentLoaded auto-run when
 * window.__polarisIpamTabs is set (this page sets it before they load).
 */

(function () {
  var activeTab = null;

  // Per-tab read gate. IP Blocks lists /blocks (ipBlocks:read) and Networks
  // lists /subnets (subnets:read), so a role holding only one of the two must
  // not be offered — or defaulted onto — the other: its first fetch 403s and
  // the page reads as broken rather than as out of scope.
  //
  // Fails OPEN when the permission matrix hasn't resolved yet (cold
  // localStorage cache — app.js restores it synchronously before this handler
  // runs, but only when there IS a cache). Hiding both tabs on a first-ever
  // login would be worse than a 403 the operator can retry.
  var TAB_PERM = { blocks: "ipBlocks", networks: "subnets" };

  function permsResolved() {
    return typeof currentRolePermissions === "object" && currentRolePermissions
      && Object.keys(currentRolePermissions).length > 0;
  }

  function tabAllowed(name) {
    if (!permsResolved() || typeof permAtLeast !== "function") return true;
    var key = TAB_PERM[name];
    return !key || permAtLeast(key, "read");
  }

  function allowedTabs() {
    return ["blocks", "networks"].filter(tabAllowed);
  }

  // Hide the button for a tab the role can't read. Runs before the first
  // mount so the strip never flashes a tab that's about to disappear.
  function applyTabPermissions() {
    Array.prototype.forEach.call(document.querySelectorAll("#ipam-tabs .page-tab"), function (btn) {
      var name = btn.getAttribute("data-tab");
      if (!tabAllowed(name)) btn.style.display = "none";
    });
  }

  function parseHash() {
    var h = (window.location.hash || "").replace(/^#/, "");
    var out = {};
    if (!h) return out;
    h.split("&").forEach(function (kv) {
      var p = kv.split("=");
      if (p.length === 2) out[decodeURIComponent(p[0])] = decodeURIComponent(p[1]);
    });
    return out;
  }

  function currentTabFromHash() {
    var p = parseHash();
    var allowed = allowedTabs();
    // A hash naming a tab the role can't read (a shared deep link, a stale
    // bookmark) falls back to whatever it CAN read rather than 403-ing.
    if ((p.tab === "blocks" || p.tab === "networks") && allowed.indexOf(p.tab) !== -1) return p.tab;
    if (allowed.indexOf("networks") !== -1) return "networks";
    return allowed[0] || "networks";
  }

  function tabButton(name) {
    return document.querySelector('#ipam-tabs .page-tab[data-tab="' + name + '"]');
  }

  function setActiveButton(name) {
    Array.prototype.forEach.call(document.querySelectorAll("#ipam-tabs .page-tab"), function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-tab") === name);
    });
  }

  async function mountTab(name) {
    if (activeTab === name) return;
    var mount = document.getElementById("ipam-mount");
    var tpl = document.getElementById("ipam-tpl-" + name);
    if (!mount || !tpl) return;
    // The head row's control slot holds the previous tab's buttons and
    // #pagination-top, whose IDs collide with the incoming template's — empty
    // it with the mount, then move the new template's [data-head-controls]
    // cluster into it before the tab's init() looks them up by id.
    // The same goes for the page navigation, which sits below the card in
    // #ipam-nav rather than inside the mount (the card).
    var slot = document.getElementById("ipam-head-controls");
    var navSlot = document.getElementById("ipam-nav");
    if (slot) slot.innerHTML = "";
    if (navSlot) navSlot.innerHTML = "";
    mount.innerHTML = "";
    mount.appendChild(tpl.content.cloneNode(true));
    var headControls = mount.querySelector("[data-head-controls]");
    if (headControls && slot) {
      while (headControls.firstChild) slot.appendChild(headControls.firstChild);
      headControls.remove();
    }
    var nav = mount.querySelector("[data-card-nav]");
    if (nav && navSlot) navSlot.appendChild(nav);
    activeTab = name;
    setActiveButton(name);
    updateExportLabels(name);
    try {
      if (name === "blocks" && window.PolarisBlocks && window.PolarisBlocks.init) {
        await window.PolarisBlocks.init();
      } else if (name === "networks" && window.PolarisSubnets && window.PolarisSubnets.init) {
        await window.PolarisSubnets.init();
      }
    } catch (err) {
      // Swallow — each module's own try/catch surfaces UI-level toast messages.
      if (typeof console !== "undefined") console.error("IPAM tab init failed:", err);
    }
  }

  function writeHash(name, preserveParams) {
    var p = preserveParams ? parseHash() : {};
    p.tab = name;
    var parts = Object.keys(p).map(function (k) {
      return encodeURIComponent(k) + "=" + encodeURIComponent(p[k]);
    });
    // Use replaceState so the tab swap doesn't pollute the browser history
    // with one entry per click; user can still ctrl/cmd-click the tab to
    // open it in a new tab if they want a navigable URL.
    var newHash = "#" + parts.join("&");
    if (window.location.hash !== newHash) {
      history.replaceState(null, "", window.location.pathname + window.location.search + newHash);
    }
  }

  function wireTabClicks() {
    Array.prototype.forEach.call(document.querySelectorAll("#ipam-tabs .page-tab"), function (btn) {
      btn.addEventListener("click", function () {
        var name = btn.getAttribute("data-tab");
        if (!name || name === activeTab) return;
        // Drop block= / subnet= / focusReservation= when manually switching
        // tabs — those params belong to the deep-link that brought us in, not
        // to subsequent tab navigation.
        writeHash(name, false);
        mountTab(name);
      });
    });
  }

  function onHashChange() {
    var name = currentTabFromHash();
    if (name !== activeTab) mountTab(name);
  }

  // The Export button + menu live in the always-present top page-header (NOT
  // inside a tab template), so they're wired exactly once here rather than by
  // each tab module. Each menu item dispatches to whichever tab is active —
  // PolarisBlocks.export() for IP Blocks, PolarisSubnets.export() for Networks.
  function updateExportLabels(name) {
    var label = name === "blocks" ? "Entire block list" : "Entire network list";
    Array.prototype.forEach.call(
      document.querySelectorAll("#export-menu .export-all-label"),
      function (b) { b.textContent = label; }
    );
  }

  function wireExport() {
    var menu = document.getElementById("export-menu");
    var btn = document.getElementById("btn-export");
    if (!btn || !menu) return;

    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      menu.classList.toggle("open");
    });
    document.addEventListener("click", function () { menu.classList.remove("open"); });
    menu.addEventListener("click", function (e) { e.stopPropagation(); });

    menu.querySelectorAll("button[data-export]").forEach(function (item) {
      item.addEventListener("click", async function () {
        menu.classList.remove("open");
        var mode = this.getAttribute("data-export");
        var fmt = this.getAttribute("data-fmt");
        var mod = activeTab === "blocks" ? window.PolarisBlocks : window.PolarisSubnets;
        if (mod && mod.export) await mod.export(mode, fmt);
      });
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    applyTabPermissions();
    wireTabClicks();
    wireExport();
    mountTab(currentTabFromHash());
    window.addEventListener("hashchange", onHashChange);
  });
})();
