/**
 * public/js/genericapi-portability.js — one Generic API integration's
 * configuration as a file (business rule 100).
 *
 * `window.PolarisGenericApiPortability`. The Generic API dialog's JSON tab
 * shows the form as this file, downloads it as a `.genericapi.json`, and reads
 * one back in the BROWSER — no upload route. An import only fills the form;
 * saving goes through the ordinary create / update route, so the server's
 * GenericApiConfigSchema stays the authority on what a configuration may say.
 *
 * Modelled on discovery-portability.js in shape. The point of the file is
 * that a mapping written once for a product (a CMDB, a camera server, a
 * printer portal) can be handed to anyone else running Polaris, so the
 * export is built to be posted publicly:
 *
 *   - **Secrets never leave.** `apiToken`, `password` and `clientSecret` (the
 *     sealed keys, utils/configSecretFields.ts) are dropped, and so is the
 *     value of any extra header whose NAME says it carries one (Authorization,
 *     a key, a token, a cookie…) — extra headers are stored unsealed, and an
 *     operator may have put a key there despite the form's warning.
 *   - **Connection details are left out unless asked for.** Host, port,
 *     username, OAuth client id and token URL say where an install's systems
 *     live and who it logs in as. `includeConnection` keeps them, for moving a
 *     configuration between an operator's own installs.
 *   - **Install-local switches are left out**: verbose logging and its
 *     timestamp describe this install's troubleshooting, not the mapping.
 *
 * Two traps, each pinned by a test (tests/unit/genericApiPortability.test.ts):
 *
 *   (a) **An import never carries a secret.** That is a property of this CODE,
 *       not a promise about the file: `parseImportFile` re-strips on the way
 *       IN, so a hand-edited file with a token in it cannot slip one into a
 *       form field the operator never looked at.
 *   (b) **Every export is a valid import** — the round trip is the headline
 *       test, as it is for Discoveries.
 *
 * **No globals needed** — pure functions over plain objects. integrations.js
 * reads this namespace guardedly; a page without it simply has no JSON tab.
 */

(function () {
  "use strict";

  var FORMAT_VERSION = 1;
  var FILE_SUFFIX = ".genericapi.json";
  /** Checked BEFORE the parse. A configuration is a few KB; 256 KB is generous. */
  var MAX_IMPORT_BYTES = 256 * 1024;
  var MAX_DEPTH = 20;
  var MAX_NAME_LEN = 100;

  /** The sealed keys — never exported, never imported. */
  var SECRET_KEYS = ["apiToken", "password", "clientSecret"];
  /** Where the install's systems live and who it logs in as. */
  var CONNECTION_KEYS = ["host", "port", "username", "clientId", "tokenUrl"];
  /**
   * This install's own state: its troubleshooting switch, and its tier-3
   * monitor settings (cadences tuned for this install; the importer's own are
   * re-derived from the monitor queries on save).
   */
  var LOCAL_KEYS = ["verboseLogging", "verboseLoggingEnabledAt", "monitorSettings"];
  /** An extra header whose name matches carries a credential: its value is dropped. */
  var CREDENTIAL_HEADER_RE = /(auth|token|key|secret|password|passwd|cookie|session|signature|credential)/i;

  // ─── Names ────────────────────────────────────────────────────────────

  function cleanName(s) {
    /* eslint-disable-next-line no-control-regex */
    var out = String(s || "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
    return out.length > MAX_NAME_LEN ? out.slice(0, MAX_NAME_LEN) : out;
  }

  function nameFromFilename(filename) {
    var base = String(filename || "").split(/[\\/]/).pop() || "";
    if (base.toLowerCase().endsWith(FILE_SUFFIX)) base = base.slice(0, -FILE_SUFFIX.length);
    else base = base.replace(/\.[^.]*$/, "");
    base = cleanName(base);
    return base === "." || base === ".." ? "" : base;
  }

  function filenameForExport(name) {
    /* eslint-disable-next-line no-control-regex */
    var safe = String(name || "").replace(/[\u0000-\u001F\u007F]/g, "")
      .replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
    if (safe.length > 120) safe = safe.slice(0, 120);
    return (safe || "generic-api") + FILE_SUFFIX;
  }

  // ─── Safety ───────────────────────────────────────────────────────────

  /** Refuse prototype-polluting keys and unbounded nesting (the discovery-portability rule). */
  function assertSafeKeys(value, depth) {
    if (depth > MAX_DEPTH) throw new Error("That file is nested too deeply to be a Generic API configuration.");
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) assertSafeKeys(value[i], depth + 1);
      return;
    }
    var keys = Object.keys(value);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new Error("That file contains a key Polaris will not read (" + key + ").");
      }
      assertSafeKeys(value[key], depth + 1);
    }
  }

  function isPlainObject(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }

  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  // ─── Strip ────────────────────────────────────────────────────────────

  /**
   * A configuration with everything install-specific removed. Returns the
   * portable config plus what was removed, by name, so the file can tell its
   * reader what to fill in.
   */
  function stripConfig(config, opts) {
    var includeConnection = !!(opts && opts.includeConnection);
    var cfg = isPlainObject(config) ? clone(config) : {};
    var removed = [];
    SECRET_KEYS.concat(LOCAL_KEYS).forEach(function (k) { delete cfg[k]; });
    if (!includeConnection) {
      CONNECTION_KEYS.forEach(function (k) {
        if (cfg[k] !== undefined && cfg[k] !== "" && cfg[k] !== null) removed.push(k);
        delete cfg[k];
      });
    }
    if (Array.isArray(cfg.headers)) {
      cfg.headers = cfg.headers.filter(isPlainObject).map(function (h) {
        var name = String(h.name || "");
        if (CREDENTIAL_HEADER_RE.test(name) && h.value) {
          removed.push("header:" + name);
          return { name: name, value: "" };
        }
        return { name: name, value: String(h.value == null ? "" : h.value) };
      });
    }
    return { config: cfg, removed: removed };
  }

  /**
   * What the importer must supply: the credential fields the auth type uses,
   * then whatever connection details and header values the export removed.
   */
  function describeNeeds(config, removed) {
    var needs = [];
    switch (config.authType) {
      case "bearer": case "header": case "query": needs.push("token"); break;
      case "basic": needs.push("password"); break;
      case "oauth2": needs.push("clientSecret"); break;
      default: break;
    }
    return needs.concat(removed || []);
  }

  /**
   * The file. The envelope carries the reader-facing hints FIRST (what to
   * fill in), the configuration last — the order a person reading it wants.
   */
  function buildExportFile(config, opts) {
    var o = opts || {};
    var stripped = stripConfig(config, o);
    var file = { polarisGenericApi: FORMAT_VERSION, exportedAt: new Date().toISOString() };
    if (o.polarisVersion) file.polarisVersion = String(o.polarisVersion);
    var name = cleanName(o.name);
    if (name) file.name = name;
    var description = cleanName(o.description);
    if (description) file.description = description;
    file.needs = describeNeeds(stripped.config, stripped.removed);
    file.config = stripped.config;
    return file;
  }

  // ─── Import ───────────────────────────────────────────────────────────

  /**
   * Parse a `.genericapi.json` — or a bare configuration pasted on its own —
   * into a config for the form. Throws an operator-facing message for
   * anything unusable; a newer format version is a non-fatal problem, since
   * the shape may still read.
   */
  function parseImportFile(text, filename) {
    var raw = String(text || "");
    if (!raw.trim()) throw new Error("That file is empty.");
    if (raw.length > MAX_IMPORT_BYTES) throw new Error("That file is too large to be a Generic API configuration.");
    var parsed;
    try { parsed = JSON.parse(raw); }
    catch (_) { throw new Error("That isn't valid JSON."); }
    assertSafeKeys(parsed, 0);
    if (!isPlainObject(parsed)) throw new Error("That file doesn't contain a Generic API configuration.");

    var problems = [];
    if (parsed.polarisDiscovery != null || parsed.polarisAutomation != null) {
      throw new Error("That is a different kind of Polaris export, not a Generic API configuration.");
    }
    if (parsed.polarisGenericApi != null && Number(parsed.polarisGenericApi) !== FORMAT_VERSION) {
      problems.push("The file says format version " + parsed.polarisGenericApi +
        "; this Polaris reads version " + FORMAT_VERSION + ". Check every tab before saving.");
    }
    var config = isPlainObject(parsed.config) ? parsed.config : parsed;
    var looksLikeOne = typeof config.path === "string" || typeof config.recordsPath === "string" ||
      isPlainObject(config.fieldMap) || typeof config.host === "string";
    if (!looksLikeOne) throw new Error("That JSON has no request path, records path or field mapping — it isn't a Generic API configuration.");

    // Trap (a): re-strip on the way IN. Connection details are kept — an
    // operator restoring their own export wants them back.
    var restripped = stripConfig(config, { includeConnection: true });
    var name = cleanName(parsed.name) || nameFromFilename(filename);
    return {
      config: restripped.config,
      name: name,
      needs: Array.isArray(parsed.needs) ? parsed.needs.map(String) : describeNeeds(restripped.config, []),
      problems: problems,
    };
  }

  window.PolarisGenericApiPortability = {
    FORMAT_VERSION: FORMAT_VERSION,
    FILE_SUFFIX: FILE_SUFFIX,
    MAX_IMPORT_BYTES: MAX_IMPORT_BYTES,
    SECRET_KEYS: SECRET_KEYS.slice(),
    CONNECTION_KEYS: CONNECTION_KEYS.slice(),
    nameFromFilename: nameFromFilename,
    filenameForExport: filenameForExport,
    stripConfig: stripConfig,
    buildExportFile: buildExportFile,
    parseImportFile: parseImportFile,
    assertSafeKeys: assertSafeKeys,
  };
})();
