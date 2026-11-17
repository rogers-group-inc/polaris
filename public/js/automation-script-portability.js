/**
 * public/js/automation-script-portability.js — one automation SCRIPT to and
 * from a file (Automations → Scripts: the card's right-click **Export**, and
 * **Import from file** in the New script dialog).
 *
 * Exposed as `window.PolarisScriptPortability`. Pure: the page owns the Blob
 * download and the file picker.
 *
 * Two file shapes come IN:
 *  - our own `.script.json` — `{ polarisScript: 1, exportedAt, name,
 *    description, interpreter, runTarget, timeoutSec, body }`;
 *  - a plain script file (`.sh`, `.py`, `.ps1`, `.cmd`, …) — the body, with
 *    the interpreter read from the extension (or a `#!` line) and the name
 *    from the file name.
 * Either way the result only FILLS the New script form. Nothing is saved until
 * the operator has read the body and pressed Create — scripts run with full
 * privileges, and an import is exactly where an unread body would slip in.
 *
 * What never goes OUT: the id, the sha256 (the server recomputes it on every
 * save — a client-supplied hash is never accepted), the enabled flag, who
 * created it, and the run history.
 */
(function () {
  "use strict";

  var FORMAT_VERSION = 1;
  var FILE_SUFFIX = ".script.json";
  // The server caps a body at 64 KB; a wrapper adds little. Checked before reading.
  var MAX_IMPORT_BYTES = 256 * 1024;
  var MAX_BODY_BYTES = 64 * 1024;
  var INTERPRETERS = ["bash", "sh", "powershell", "cmd", "python3"];
  var RUN_TARGETS = ["server", "agent", "either"];
  var EXT_INTERPRETER = { sh: "bash", bash: "bash", py: "python3", ps1: "powershell", cmd: "cmd", bat: "cmd" };
  var INTERPRETER_EXT = { bash: "sh", sh: "sh", python3: "py", powershell: "ps1", cmd: "cmd" };

  function isPlainObject(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }

  function utf8Bytes(s) {
    try { return new TextEncoder().encode(s).length; } catch (_e) { return String(s).length; }
  }

  /** A file-system-safe base name for a script. */
  function safeBase(name) {
    var b = String(name || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/\s+/g, " ").trim();
    return b.slice(0, 120) || "script";
  }

  /** The export document for one script row. */
  function exportScript(sc, now) {
    return {
      polarisScript: FORMAT_VERSION,
      exportedAt: (now || new Date()).toISOString(),
      name: sc.name,
      description: sc.description || null,
      interpreter: sc.interpreter,
      runTarget: sc.runTarget,
      timeoutSec: sc.timeoutSec,
      body: sc.body,
    };
  }

  function exportText(sc, now) { return JSON.stringify(exportScript(sc, now), null, 2) + "\n"; }
  function filenameForExport(sc) { return safeBase(sc.name) + FILE_SUFFIX; }

  function interpreterFromShebang(body) {
    var first = String(body || "").split(/\r?\n/, 1)[0] || "";
    if (first.indexOf("#!") !== 0) return null;
    if (/python3?\b/.test(first)) return "python3";
    if (/\bbash\b/.test(first)) return "bash";
    if (/\bpwsh\b|powershell/i.test(first)) return "powershell";
    if (/\/sh\b|\bsh$/.test(first)) return "sh";
    return null;
  }

  function nameFromFilename(filename) {
    var base = String(filename || "").split(/[\\/]/).pop() || "";
    if (base.toLowerCase().slice(-FILE_SUFFIX.length) === FILE_SUFFIX) base = base.slice(0, -FILE_SUFFIX.length);
    else base = base.replace(/\.[^.]*$/, "");
    return base.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  }

  /**
   * Parse a picked file into the New script form's fields. Throws Error with an
   * operator-facing message. Returns { name, description, interpreter,
   * runTarget, timeoutSec, body, fromExport, interpreterGuessed, problems: [] }
   * — `problems` are notes the form shows (a guessed interpreter, a field it
   * could not use), never blockers. `fromExport` says the file was a
   * .script.json (every field is the file's own); on a plain file only the body
   * and — unless `interpreterGuessed` — the interpreter came from the file, which
   * is what an import into an EXISTING script replaces.
   */
  function parseImportFile(text, filename) {
    if (typeof text !== "string" || !text.trim()) throw new Error("That file is empty.");
    if (text.length > MAX_IMPORT_BYTES) throw new Error("That file is too large to be a script.");
    var problems = [];
    var lower = String(filename || "").toLowerCase();
    var out;
    if (lower.slice(-FILE_SUFFIX.length) === FILE_SUFFIX || lower.slice(-5) === ".json") {
      var doc;
      try { doc = JSON.parse(text); } catch (err) { throw new Error("Invalid JSON: " + ((err && err.message) || "could not be parsed")); }
      if (!isPlainObject(doc) || typeof doc.body !== "string") throw new Error("That file is not a Polaris script export (no body).");
      if (doc.polarisScript != null && doc.polarisScript !== FORMAT_VERSION) {
        problems.push("This file says format version " + String(doc.polarisScript) + "; this Polaris reads version " + FORMAT_VERSION + ". Check every field before saving.");
      }
      out = {
        name: typeof doc.name === "string" ? doc.name.trim().slice(0, 200) : nameFromFilename(filename),
        description: typeof doc.description === "string" ? doc.description.slice(0, 4000) : "",
        interpreter: INTERPRETERS.indexOf(doc.interpreter) !== -1 ? doc.interpreter : null,
        runTarget: RUN_TARGETS.indexOf(doc.runTarget) !== -1 ? doc.runTarget : "server",
        timeoutSec: Number.isInteger(doc.timeoutSec) && doc.timeoutSec >= 1 && doc.timeoutSec <= 600 ? doc.timeoutSec : 60,
        body: doc.body,
        fromExport: true,
        interpreterGuessed: false,
      };
      if (!out.interpreter) {
        out.interpreter = interpreterFromShebang(doc.body) || "bash";
        out.interpreterGuessed = true;
        problems.push('The file names no interpreter this Polaris knows, so "' + out.interpreter + '" was picked — check it.');
      }
    } else {
      var ext = (lower.match(/\.([a-z0-9]+)$/) || [])[1] || "";
      var interp = EXT_INTERPRETER[ext] || interpreterFromShebang(text);
      var guessed = !interp;
      if (!interp) {
        interp = "bash";
        problems.push('Could not tell the interpreter from "' + (ext ? "." + ext : "the file") + '", so bash was picked — check it.');
      }
      out = { name: nameFromFilename(filename), description: "", interpreter: interp, runTarget: "server", timeoutSec: 60, body: text, fromExport: false, interpreterGuessed: guessed };
    }
    if (!out.body.trim()) throw new Error("That file has an empty script body.");
    if (utf8Bytes(out.body) > MAX_BODY_BYTES) throw new Error("The script body is larger than 64 KB, which Polaris does not accept.");
    if (!out.name) problems.push("The file has no usable name — type one before saving.");
    out.problems = problems;
    return out;
  }

  var api = {
    FORMAT_VERSION: FORMAT_VERSION,
    FILE_SUFFIX: FILE_SUFFIX,
    MAX_IMPORT_BYTES: MAX_IMPORT_BYTES,
    INTERPRETER_EXT: INTERPRETER_EXT,
    exportScript: exportScript,
    exportText: exportText,
    filenameForExport: filenameForExport,
    parseImportFile: parseImportFile,
  };
  if (typeof window !== "undefined") window.PolarisScriptPortability = api;
})();
