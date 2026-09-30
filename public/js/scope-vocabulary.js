/* global api */
/**
 * public/js/scope-vocabulary.js — the DEVICE-SELECTION vocabulary shared by
 * every surface that picks devices with the automations' own field set.
 *
 * `window.PolarisScopeVocabulary`.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * `PolarisConditionBuilder` (condition-builder.js) holds no catalog on purpose:
 * each consumer injects its own `meta` and `valueOptions(field)`. That is what
 * lets one widget serve surfaces whose value sources differ — but it also means
 * the value-suggestion switch is copied per surface, and the canon records the
 * cost: each copy ends `default: return []`, so a field given a NEW
 * `optionsFrom` degrades to a free-text box on every surface whose switch was
 * not updated, and nothing throws.
 *
 * The Alert Groups editor would have been the next copy. It does not need to
 * be: it sits behind `automationManagement`, the SAME gate as the automation
 * wizard's Devices step, and wants the SAME field set from the SAME endpoints.
 * Two surfaces with one vocabulary get one module — the `resolveDeviceFilterAssetIds`
 * precedent, which moved out of contactService the moment a second caller
 * wanted it rather than being copied.
 *
 * This deliberately does NOT absorb the other three consumers (the address
 * book, Mass Pinning, the tag registry). Each of those is behind a DIFFERENT
 * permission key and reads its own schema route for that reason, and two of
 * them use a wider field set. Folding them in here would re-introduce the
 * coupling those separate routes exist to avoid.
 */
(function () {
  "use strict";

  /**
   * The catalog to use when the server did not send one.
   *
   * Lifted verbatim from the wizard, which carried it inline. It is a fallback
   * and nothing more: `buildSchemaCatalog().scopeCondition` is the source of
   * truth, and a field added there appears in every consumer with no client
   * edit at all.
   */
  var FALLBACK_META = {
    groupOps: ["and", "or", "none", "notAll"],
    groupOpLabels: {
      and: "All child conditions must be satisfied (AND)",
      or: "At least one child condition must be satisfied (OR)",
      none: "All child conditions must NOT be satisfied",
      notAll: "At least one child condition must NOT be satisfied",
    },
    operatorLabels: {
      equals: "is equal to", notEquals: "is not equal to",
      contains: "contains", notContains: "does not contain",
      startsWith: "starts with", endsWith: "ends with",
      has: "is applied", notHas: "is not applied",
      inCidr: "is within", notInCidr: "is not within",
    },
    fields: [
      { field: "assetType", label: "Device type", ops: ["equals", "notEquals"], optionsFrom: "assetTypes" },
      { field: "manufacturer", label: "Manufacturer", ops: ["equals", "notEquals", "contains", "notContains", "startsWith", "endsWith"], optionsFrom: "manufacturers" },
      { field: "model", label: "Model", ops: ["equals", "notEquals", "contains", "notContains", "startsWith", "endsWith"], optionsFrom: "models" },
      { field: "hostname", label: "Hostname", ops: ["equals", "notEquals", "contains", "notContains", "startsWith", "endsWith"], optionsFrom: null },
      { field: "os", label: "Operating system", ops: ["equals", "notEquals", "contains", "notContains", "startsWith", "endsWith"], optionsFrom: null },
      { field: "tag", label: "Tag", ops: ["has", "notHas"], optionsFrom: "tags" },
      { field: "subnet", label: "Subnet / IP", ops: ["inCidr", "notInCidr"], optionsFrom: "subnets" },
      { field: "ipBlock", label: "IP block", ops: ["inCidr", "notInCidr"], optionsFrom: "ipBlocks" },
      { field: "interfaceName", label: "Device interface", ops: ["equals", "notEquals", "contains", "notContains", "startsWith", "endsWith"], optionsFrom: "interfaceNames" },
      { field: "ssid", label: "Broadcast SSID", ops: ["equals", "notEquals", "contains", "notContains", "startsWith", "endsWith"], optionsFrom: "ssids" },
      { field: "status", label: "Lifecycle status", ops: ["equals", "notEquals"], optionsFrom: null, values: ["active", "maintenance", "decommissioned", "storage", "disabled", "quarantined"] },
      // Asset ID intentionally omitted — a raw id targets one device with no
      // precedence meaning; use hostname. Saved rules using it still evaluate.
    ],
    maxDepth: 5,
  };

  /** A device id masquerading as a tag — filtered out of the tag picker. */
  function looksLikeDeviceId(t) {
    return /^[A-Z0-9]{10,}$/.test(String(t || ""));
  }

  /**
   * Build the pair `PolarisConditionBuilder.create` needs from already-loaded
   * payloads. Pure — every source is passed in, nothing is fetched here, so a
   * caller that already holds the data (the wizard) pays nothing twice.
   */
  function make(sources) {
    var src = sources || {};
    var meta = (src.schema && src.schema.scopeCondition) || FALLBACK_META;
    var assetTypes = src.assetTypes || [];
    var tagList = src.tagList || [];
    var opts = src.scopeOptions || {};

    function fieldMeta(field) {
      var fields = meta.fields || [];
      return fields.find(function (f) { return f.field === field; }) || fields[0];
    }

    /**
     * THE one value-suggestion switch. A new `optionsFrom` gets its case here
     * and every consumer of this module has it at once — which is the whole
     * reason the module exists.
     */
    function valueOptions(field) {
      var fm = fieldMeta(field);
      if (!fm) return [];
      if (fm.values) return fm.values.map(function (v) { return { value: v, label: v }; });
      switch (fm.optionsFrom) {
        case "assetTypes":     return assetTypes.map(function (t) { return { value: t.name, label: t.label || t.name }; });
        case "manufacturers":  return (opts.manufacturers || []).map(function (m) { return { value: m, label: m }; });
        case "models":         return (opts.models || []).map(function (m) { return { value: m, label: m }; });
        case "interfaceNames": return (opts.interfaceNames || []).map(function (n) { return { value: n, label: n }; });
        case "ssids":          return (opts.ssids || []).map(function (n) { return { value: n, label: n }; });
        case "tags":           return tagList.map(function (t) { return { value: t, label: t }; });
        case "subnets":        return (opts.subnets || []).map(function (sn) { return { value: sn.cidr, label: sn.name + " — " + sn.cidr }; });
        case "ipBlocks":       return (opts.ipBlocks || []).map(function (b) { return { value: b.cidr, label: b.name + " — " + b.cidr }; });
        default: return [];
      }
    }

    return { meta: meta, fieldMeta: fieldMeta, valueOptions: valueOptions };
  }

  /**
   * Fetch the four payloads and build the vocabulary, for a caller that does
   * not already hold them.
   *
   * Every read is best-effort: a failed option list degrades that one field to
   * a free-text box, which is worse than a picker and much better than a
   * dialog that will not open. The caller still gets a usable builder.
   *
   * Reads `/automations/*`, so ONLY call it from a surface already behind
   * `automationManagement:read` — see this file's header.
   */
  async function load() {
    var schema = null, assetTypes = [], tagList = [], scopeOptions = {};
    try { schema = await api.automations.schema(); } catch (e) { schema = null; }
    try {
      var td = await api.assets.tags();
      tagList = ((td && td.tags) || []).filter(function (t) { return !looksLikeDeviceId(t); });
    } catch (e) { tagList = []; }
    try {
      var at = await api.assetTypes.list();
      assetTypes = Array.isArray(at) ? at : ((at && (at.types || at.assetTypes)) || []);
    } catch (e) { assetTypes = []; }
    try { scopeOptions = await api.automations.scopeOptions(); } catch (e) { scopeOptions = {}; }
    return make({ schema: schema, assetTypes: assetTypes, tagList: tagList, scopeOptions: scopeOptions });
  }

  window.PolarisScopeVocabulary = { make: make, load: load, FALLBACK_META: FALLBACK_META };
})();
