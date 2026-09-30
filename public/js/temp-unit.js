/**
 * public/js/temp-unit.js — display-unit conversion for hardware-sensor readings.
 *
 * Polaris collects, stores, rolls up, and ALERTS ON temperatures in Celsius —
 * `SENSOR_CLASS_UNITS.temperature` in src/utils/hardwareSensors.ts is the single
 * source of truth, and the automation engine compares thresholds against the
 * stored number. So an operator who wants Fahrenheit gets it at RENDER time
 * only: nothing here touches a sample, a rollup, a threshold, or an automation.
 * (Converting before storage is the WRONG lever — it would rewrite stored values,
 * silently re-point every temperature automation's threshold, and step each
 * sensor's history mid-series. The Manufacturer Profiles Celsius↔Fahrenheit
 * transform that invited it was removed 2026-09-23.)
 *
 * The preference is install-wide: `branding.temperatureUnit` ("c" | "f"), which
 * app.js already fetches and mirrors into localStorage. Reading it from that
 * cache keeps this module SYNCHRONOUS, which is what lets the sync
 * string-building renderers (the Hardware Sensors table, chart tooltips, the
 * mobile sheet) call it inline. It also reaches the Dash wallboard, which has no
 * user identity for a per-user preference to hang off.
 *
 * Conversion is gated on the READING'S OWN stored unit, never on its class: a
 * fan's RPM and a rail's volts flow through untouched, and a row whose unit the
 * device didn't report is left alone rather than guessed at.
 *
 * Pure and DOM-free (localStorage access is optional + guarded), exposed on
 * window.PolarisTempUnit. Unit-tested in tests/unit/tempUnit.test.ts.
 */
(function () {
  "use strict";

  var CACHE_KEY = "polaris-branding";
  var CELSIUS_LABEL = "°C";
  var FAHRENHEIT_LABEL = "°F";

  // null = not resolved yet; resolved lazily so load order doesn't matter.
  var _unit = null;

  function normalize(u) {
    return String(u == null ? "" : u).trim().toLowerCase() === "f" ? "f" : "c";
  }

  function readCachedUnit() {
    try {
      if (typeof localStorage === "undefined" || !localStorage) return "c";
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return "c";
      return normalize(JSON.parse(raw).temperatureUnit);
    } catch (_) {
      return "c";
    }
  }

  /** The active display unit code, "c" or "f". */
  function unit() {
    if (_unit === null) _unit = readCachedUnit();
    return _unit;
  }

  function isFahrenheit() { return unit() === "f"; }

  /**
   * Adopt the unit from a freshly fetched branding payload. Called by app.js's
   * applyBranding so a change takes effect without a reload — and so the very
   * first page load (empty localStorage) doesn't render Celsius and stay there.
   */
  function setFromBranding(b) {
    _unit = normalize(b && b.temperatureUnit);
    return _unit;
  }

  /** Test seam / explicit override. */
  function setUnit(u) { _unit = normalize(u); return _unit; }

  /** Is this stored unit string a Celsius reading we're allowed to convert? */
  function isCelsiusUnit(u) {
    return typeof u === "string" && /^\s*(?:°\s*)?c\s*$/i.test(u);
  }

  /** Convert a value KNOWN to be Celsius (chart series, thresholds, °C widgets). */
  function convertCelsius(v) {
    if (typeof v !== "number" || !isFinite(v)) return v;
    return isFahrenheit() ? v * 9 / 5 + 32 : v;
  }

  /**
   * Convert one reading given the unit the device reported it in. Non-Celsius
   * readings (RPM, V, unitless) and unknown units pass through unchanged.
   */
  function convertReading(v, storedUnit) {
    return isCelsiusUnit(storedUnit) ? convertCelsius(v) : v;
  }

  /** The label to render for a stored unit — swapped only for Celsius. */
  function displayUnit(storedUnit) {
    if (!isCelsiusUnit(storedUnit)) return storedUnit;
    return isFahrenheit() ? FAHRENHEIT_LABEL : CELSIUS_LABEL;
  }

  /** The label for a series known to be Celsius. */
  function celsiusLabel() {
    return isFahrenheit() ? FAHRENHEIT_LABEL : CELSIUS_LABEL;
  }

  window.PolarisTempUnit = {
    unit: unit,
    isFahrenheit: isFahrenheit,
    setFromBranding: setFromBranding,
    setUnit: setUnit,
    isCelsiusUnit: isCelsiusUnit,
    convertCelsius: convertCelsius,
    convertReading: convertReading,
    displayUnit: displayUnit,
    celsiusLabel: celsiusLabel,
    CELSIUS_LABEL: CELSIUS_LABEL,
    FAHRENHEIT_LABEL: FAHRENHEIT_LABEL,
  };
})();
