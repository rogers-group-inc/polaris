/**
 * public/js/dashboard-portability.js — export / import ONE dashboard tab as a
 * `.dashboard.json` file (window.PolarisDashboardPortability).
 *
 * The file-shaped sibling of saved dashboards (dashboard-saved.js): a saved
 * dashboard moves a canvas between operators on ONE install; this moves it
 * between installs (lab → prod, one customer's Polaris → another's), or into
 * git. Pure functions only — no DOM, no fetch — so the menu in
 * dashboard-saved.js owns the download/upload plumbing and tests can drive the
 * format directly.
 *
 * What travels: the tab's name and its columns (width + widget type, height,
 * config). What does NOT: column and widget instance ids — they are minted per
 * canvas and loadAsNewTab mints fresh ones anyway — and nothing else exists on
 * a tab to leak. Widget configs hold display choices and NAMES (region names,
 * FortiGate device names), never ids or secrets, so a config naming a region
 * the importing install lacks simply matches nothing there.
 *
 * Import is a COPY into a new tab of the viewer's own layout, through the same
 * PolarisDashboard.loadAsNewTab seam a saved dashboard loads through — so its
 * dropUnknownWidgets pass (unregistered widget types, bad heights/widths) is
 * applied to a file exactly as it is to another operator's published row.
 * parseImportFile counts the widgets that pass will drop so the toast can say
 * so instead of a widget silently going missing.
 */
(function () {
  "use strict";

  var FORMAT_VERSION = 1;
  var FILE_SUFFIX = ".dashboard.json";
  // A full tab is a few KB; 256 KB matches the automation import cap and is
  // checked before the file is read at all.
  var MAX_IMPORT_BYTES = 256 * 1024;
  // Generous ceilings that only stop a hostile or corrupt file from building a
  // canvas the browser can't render. The editor has no hard caps of its own.
  var MAX_COLUMNS = 24;
  var MAX_WIDGETS = 200;
  var MAX_DEPTH = 20;
  var MAX_NAME_LEN = 60; // the tab-name input's maxlength

  function isPlainObject(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }

  /** Reject prototype-polluting keys anywhere in the file: widget configs are
   *  spread into live objects by the widget renderers. */
  function assertSafeKeys(value, depth) {
    if (depth > MAX_DEPTH) throw new Error("This file nests too deeply to be a dashboard.");
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) assertSafeKeys(value[i], depth + 1);
      return;
    }
    if (!isPlainObject(value)) return;
    var keys = Object.keys(value);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new Error('This file contains a "' + key + '" key, which is not allowed.');
      }
      assertSafeKeys(value[key], depth + 1);
    }
  }

  function cleanName(raw) {
    var s = String(raw == null ? "" : raw)
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return s.length > MAX_NAME_LEN ? s.slice(0, MAX_NAME_LEN).trim() : s;
  }

  /** "NOC overview" → "NOC overview.dashboard.json" */
  function filenameForExport(name) {
    var base = String(name == null ? "" : name)
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/[\\/:*?"<>|]/g, "-") // illegal on Windows, and path-ish everywhere
      .replace(/\s+/g, " ")
      .trim();
    if (base.length > 120) base = base.slice(0, 120).trim();
    if (!base) base = "dashboard";
    return base + FILE_SUFFIX;
  }

  /** The filename minus its extension — the fallback name for a file whose `name` is blank. */
  function nameFromFilename(filename) {
    var parts = String(filename == null ? "" : filename).split(/[\\/]/);
    var base = parts[parts.length - 1] || "";
    if (base.toLowerCase().slice(-FILE_SUFFIX.length) === FILE_SUFFIX) base = base.slice(0, -FILE_SUFFIX.length);
    else base = base.replace(/\.[^.]*$/, "");
    base = cleanName(base);
    return base === "." || base === ".." ? "" : base;
  }

  /**
   * A dashboard snapshot ({ name, layout: { columns } }, from
   * PolarisDashboard.snapshot()) → the file's object. Instance ids are dropped;
   * the key order puts what a human opening the file reads first.
   */
  function buildExport(snapshot, opts) {
    var o = opts || {};
    var columns = (snapshot && snapshot.layout && Array.isArray(snapshot.layout.columns))
      ? snapshot.layout.columns : [];
    var out = {
      polarisDashboard: FORMAT_VERSION,
      name: cleanName(snapshot && snapshot.name) || "Dashboard",
      exportedAt: (o.now || new Date()).toISOString(),
      columns: columns.map(function (col) {
        return {
          width: col.width,
          widgets: (col.widgets || []).map(function (w) {
            return {
              type: w.type,
              height: w.height,
              config: isPlainObject(w.config) ? JSON.parse(JSON.stringify(w.config)) : {},
            };
          }),
        };
      }),
    };
    return out;
  }

  /** buildExport, serialized the way it is written to disk. */
  function exportText(snapshot, opts) {
    return JSON.stringify(buildExport(snapshot, opts), null, 2) + "\n";
  }

  /**
   * Parse a `.dashboard.json` file into the shape loadAsNewTab takes:
   * { name, layout: { columns }, skipped, problems }. Throws an Error whose
   * message is fit for a toast when the file is not a dashboard at all.
   *
   * `isKnownType(type)` (optional) is the viewer's widget registry; widgets it
   * rejects are counted in `skipped` (loadAsNewTab drops them itself).
   */
  function parseImportFile(text, filename, isKnownType) {
    if (typeof text !== "string" || !text.trim()) throw new Error("That file is empty.");
    if (text.length > MAX_IMPORT_BYTES) throw new Error("That file is too large to be a dashboard.");

    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error("Invalid JSON: " + ((err && err.message) || "could not be parsed"));
    }
    assertSafeKeys(parsed, 0);
    if (!isPlainObject(parsed)) throw new Error("A dashboard file must contain a JSON object.");
    if (!Array.isArray(parsed.columns)) throw new Error("That file has no columns, so it isn't a dashboard.");

    var problems = [];
    var version = parsed.polarisDashboard;
    if (version != null && version !== FORMAT_VERSION) {
      problems.push("format version " + String(version) + " (this Polaris reads version " + FORMAT_VERSION + ")");
    }
    if (parsed.columns.length > MAX_COLUMNS) {
      throw new Error("That file has " + parsed.columns.length + " columns; a dashboard can hold at most " + MAX_COLUMNS + ".");
    }

    var total = 0;
    var skipped = 0;
    var columns = parsed.columns.map(function (col) {
      if (!isPlainObject(col)) throw new Error("That file's columns are not all objects.");
      if (col.widgets != null && !Array.isArray(col.widgets)) throw new Error("A column's widgets are not a list.");
      var widgets = (col.widgets || []).filter(function (w) {
        if (!isPlainObject(w) || typeof w.type !== "string" || !w.type) { skipped++; return false; }
        total++;
        if (typeof isKnownType === "function" && !isKnownType(w.type)) { skipped++; return false; }
        return true;
      }).map(function (w) {
        return { type: w.type, height: w.height, config: isPlainObject(w.config) ? w.config : {} };
      });
      return { width: col.width, widgets: widgets };
    });
    if (total > MAX_WIDGETS) {
      throw new Error("That file has " + total + " widgets; a dashboard can hold at most " + MAX_WIDGETS + ".");
    }

    var name = cleanName(parsed.name) || nameFromFilename(filename) || "Imported dashboard";
    return { name: name, layout: { columns: columns }, skipped: skipped, problems: problems };
  }

  window.PolarisDashboardPortability = {
    FORMAT_VERSION: FORMAT_VERSION,
    FILE_SUFFIX: FILE_SUFFIX,
    MAX_IMPORT_BYTES: MAX_IMPORT_BYTES,
    buildExport: buildExport,
    exportText: exportText,
    filenameForExport: filenameForExport,
    nameFromFilename: nameFromFilename,
    parseImportFile: parseImportFile,
  };
})();
