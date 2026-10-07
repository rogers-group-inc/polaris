// public/js/appmap-export.js — the Application Map's Export menu.
//
// The toolbar's Export button opens the shared menu (graph-export.js):
// Screenshot / PDF / Visio. This file only says what the App Map's export
// contains — its title, what narrowed the view, and the Ports key — and
// leaves drawing, paging and the minimum printed text size to
// window.PolarisGraphExport.
//
// Depends on: window.PolarisAppMap (appmap.js), window.PolarisGraphExport.

(function () {
  "use strict";

  var PILL_LABELS = { proto: "proto", port: "port", asset: "host", type: "type", process: "process", service: "service", external: "external", text: "text" };

  // PURE (exposed for tests): the header lines under the title.
  function metaLines(raw) {
    var first = [];
    if (raw.seenWithin) first.push("Seen within: " + raw.seenWithin);
    if (raw.status) first.push(raw.status);
    var second = [];
    if (raw.pills.length) {
      second.push("Filters: " + raw.pills.map(function (p) { return (PILL_LABELS[p.kind] || p.kind) + ": " + p.value; }).join(", "));
    }
    if (raw.hiddenPorts.length) {
      second.push("Hidden ports: " + raw.hiddenPorts.map(function (k) { return k === "other" ? "Other" : k; }).join(", "));
    }
    if (raw.hideExternal) second.push("External hidden");
    if (raw.hideWorkstations) second.push("Workstations hidden");
    return [first.join("  |  "), second.join("  |  ")].filter(Boolean);
  }

  // PURE (exposed for tests): the Ports key as it was drawn — hidden rows are
  // not on the export, so they are not in its key either — plus what the
  // stroke means.
  function keyItems(raw) {
    var items = [];
    var legend = raw.legend;
    if (legend) {
      legend.rows.forEach(function (r) {
        if (r.hidden) return;
        var svc = raw.portServiceName(r.key);
        items.push({ kind: "line", color: r.color || raw.neutralEdgeColor, text: r.key + (svc ? " " + svc : "") });
      });
      if (legend.other.count && !legend.other.hidden) items.push({ kind: "line", color: raw.neutralEdgeColor, text: "Other" });
    }
    items.push({ kind: "line", color: "#555555", text: "dashed = external", dashed: true });
    items.push({ kind: "line", color: "#555555", text: "heavy = process to process", heavy: true });
    return items;
  }

  function context() {
    var raw = window.PolarisAppMap.exportContext();
    return {
      cy: raw.cy,
      lightStylesheet: raw.stylesheet,
      title: "Application Map",
      fileBase: "polaris-application-map",
      noun: "map",
      metaLines: metaLines(raw),
      keyItems: keyItems(raw),
      scopeNote: "Exports what is on screen now: the current filters, hidden ports and node positions.",
    };
  }

  document.addEventListener("DOMContentLoaded", function () {
    var btn = document.getElementById("appmap-export");
    if (!btn) return;
    btn.addEventListener("click", function () {
      window.PolarisGraphExport.openMenu(btn, context, {
        screenshot: function () { window.PolarisAppMap.screenshot(); },
        screenshotLabel: "Copy screenshot (map + info panel)",
      });
    });
  });

  window.PolarisAppMapExport = { metaLines: metaLines, keyItems: keyItems };
})();
