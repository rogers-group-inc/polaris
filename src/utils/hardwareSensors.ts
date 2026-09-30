/**
 * src/utils/hardwareSensors.ts
 *
 * Classification helpers for the Hardware Sensors stream. A FortiGate's
 * fgHwSensorTable (and most vendors' sensor tables) mix temperature, fan,
 * voltage, power/PSU, and disk-temp rows with NO type column over SNMP — so we
 * infer the class (and its display unit) from the sensor name. FortiOS REST
 * sensor-info DOES carry a `type` field; when present it takes precedence over
 * the name heuristic.
 *
 * Best-effort by design: an unrecognized sensor falls to `other` with no unit
 * rather than being dropped, so the operator still sees the raw reading +
 * alarm status. Kept dependency-free so it unit-tests without a Prisma/SNMP
 * client in scope.
 */

export type HardwareSensorClass =
  | "temperature"
  | "fan"
  | "voltage"
  | "current"
  | "optical"
  | "poe"
  | "power"
  | "disk"
  | "other";

export interface ClassifiedSensor {
  sensorClass: HardwareSensorClass;
  /** Display unit for the reading, or null when the class has no natural unit. */
  unit: string | null;
}

/**
 * Canonical display unit per sensor class. Single source of truth shared by
 * the classifier below and the automation-builder schema (`sensorClassUnits`),
 * so the wizard's unit hint can never drift from what the samples store.
 * `power` and `other` have no natural unit (PSU rows are status-style values).
 */
export const SENSOR_CLASS_UNITS: Record<HardwareSensorClass, string | null> = {
  temperature: "°C",
  fan:         "RPM",
  voltage:     "V",
  // Transceiver TX bias. Stored in BASE amperes because scaleEntitySensor
  // resolves ENTITY-SENSOR's scale exponent back to base units — a device
  // reporting 35 mA lands here as 0.035.
  current:     "A",
  // RX / TX optical power. Its own class rather than `power` because the unit
  // differs (dBm vs none) and because "which optic is going dark" is the thing
  // an operator wants to scope an automation to — sensorClass IS that filter.
  optical:     "dBm",
  // Unit-level PoE from pethMainPseTable — the switch's power budget and what
  // it is actually delivering. Its own class rather than `power`, whose
  // canonical unit is deliberately null because that class also carries
  // Fortinet's status-shaped PSU rows; mixing real watts in would make the
  // wizard's per-class unit hint wrong for both. It is also the dimension an
  // operator scopes to when the question is "is this switch running out of
  // PoE budget".
  poe:         "W",
  power:       null,
  disk:        "°C",
  other:       null,
};

function cls(sensorClass: HardwareSensorClass): ClassifiedSensor {
  return { sensorClass, unit: SENSOR_CLASS_UNITS[sensorClass] };
}

/**
 * Classify one sensor. `restType` is the FortiOS REST `type` field when the
 * source is sensor-info (authoritative); omit it for SNMP rows so the name
 * heuristic decides.
 */
export function classifyHardwareSensor(
  name: string,
  restType?: string | null,
): ClassifiedSensor {
  const t = (restType ?? "").trim().toLowerCase();
  if (t) {
    if (t.includes("temp"))                       return cls("temperature");
    if (t.includes("fan"))                        return cls("fan");
    if (t.includes("volt"))                       return cls("voltage");
    if (t.includes("power") || t === "psu")       return cls("power");
  }

  const n = (name ?? "").trim().toLowerCase();
  // Order matters: fan/voltage/power names can also contain digits that the
  // temperature pattern would catch, so test the specific classes first.
  if (/\bfan\b|rpm|tach/.test(n))                 return cls("fan");
  // Optical power MUST precede the generic power test — "SFP1 RX Power" and
  // "Tx Power" both contain "power" and would otherwise land in `power` with
  // no unit, losing the dBm reading that makes an optic's decline visible.
  if (/\b[rt]x[\s_-]*(power|pwr)\b|\bopt(ical)?[\s_-]*(power|pwr)\b|dbm/.test(n))
                                                  return cls("optical");
  // Transceiver bias current, likewise before `power`.
  if (/\bbias\b/.test(n))                         return cls("current");
  if (/\bvol\b|voltage|vcc|vdd|vrm|\bvin\b|p\d*v\d/.test(n)) return cls("voltage");
  if (/psu|power|\bpwr\b/.test(n))                return cls("power");
  if (/\bdisk\b|nvme|\bssd\b|\bhdd\b/.test(n))    return cls("disk");
  if (/temp|tmp|dts|adt\d|lm7\d|thermal|cputin|peci|°c/.test(n))
                                                  return cls("temperature");
  // Marvell switch-chip temps on FortiGates surface as mvlgen_* / MV_88E*.
  if (/^mv[_l]/.test(n))                          return cls("temperature");
  return cls("other");
}

// ─── ENTITY-SENSOR-MIB (RFC 3433) ──────────────────────────────────────────

/**
 * `entPhySensorType` → our class. RFC 3433's EntitySensorDataType is
 * `other(1) unknown(2) voltsAC(3) voltsDC(4) amperes(5) watts(6) hertz(7)
 * celsius(8) percentRH(9) rpm(10) cmm(11) truthvalue(12)`.
 *
 * Note what is NOT in that list: **dBm**. The enum has no optical-power member,
 * so vendors report RX/TX power as `other(1)` or `watts(6)` and name the real
 * unit in `entPhySensorUnitsDisplay` — which is why that column is walked and
 * consulted ahead of the type code.
 *
 * `watts(6)` maps to `power`, whose canonical unit is deliberately null (the
 * class also carries Fortinet's status-shaped PSU rows). A true wattage reading
 * therefore stores without a unit label; acceptable because switch PSU wattage
 * is not what this collection is for, and keeping one unit per class is what
 * the automation builder's `sensorClassUnits` hint depends on.
 */
const ENTITY_SENSOR_CLASS_BY_TYPE: Readonly<Record<number, HardwareSensorClass>> = {
  1: "other",
  2: "other",
  3: "voltage",
  4: "voltage",
  5: "current",
  6: "power",
  7: "other",
  8: "temperature",
  9: "other",
  10: "fan",
  11: "other",
  12: "other",
};

/** `entPhySensorUnitsDisplay` strings that mean optical power. */
export function unitsDisplayLooksOptical(unitsDisplay: string | null | undefined): boolean {
  return /\bdbm?w?\b/i.test((unitsDisplay ?? "").trim());
}

/**
 * Whether `entPhySensorType` can be believed on this device.
 *
 * FortiSwitchOS stamps `celsius(8)` on EVERY row of its entPhySensorTable —
 * SFP optical readings, fan tachs and voltage rails included. A device whose
 * whole table reports one type is therefore not describing its sensors, it is
 * defaulting; classify from the name instead. A device that reports two or more
 * distinct types is populating the column for real and should be trusted over
 * any name heuristic (a compliant agent labelling `celsius(8)` on a row named
 * "Fan Inlet Temp" means temperature, and the word "fan" must not win).
 *
 * A single-row table is trusted — there is nothing to be uniform WITH, and the
 * alternative would mis-handle a device with exactly one sensor.
 */
export function entityTypeColumnTrusted(typeCodes: readonly number[]): boolean {
  if (typeCodes.length <= 1) return true;
  const first = typeCodes[0];
  return typeCodes.some((t) => t !== first);
}

/**
 * Classify one ENTITY-SENSOR-MIB row, in descending order of evidence quality:
 *
 *   1. `entPhySensorUnitsDisplay` saying dBm — the only trustworthy signal for
 *      optical power, since the type enum cannot express it.
 *   2. The type code, when the column is trustworthy (see above).
 *   3. The `entPhysicalDescr` name heuristic — what rescues an untrusted
 *      device's voltage / bias / optical rows.
 *   4. The type code anyway. This is the fallback that PRESERVES existing
 *      behaviour: a FortiSwitch's unnamed `sensor-18` row has no descr to
 *      classify by, and its `celsius(8)` is how it has always become a
 *      temperature row.
 */
export function classifyEntitySensor(opts: {
  typeCode: number | null;
  unitsDisplay?: string | null;
  descr?: string | null;
  typeColumnTrusted: boolean;
}): ClassifiedSensor {
  const { typeCode, unitsDisplay, descr, typeColumnTrusted } = opts;

  if (unitsDisplayLooksOptical(unitsDisplay)) return cls("optical");

  const byType = typeCode != null ? ENTITY_SENSOR_CLASS_BY_TYPE[typeCode] : undefined;
  if (typeColumnTrusted && byType && byType !== "other") return cls(byType);

  const byName = classifyHardwareSensor(descr ?? "");
  if (byName.sensorClass !== "other") return byName;

  return cls(byType ?? "other");
}

/**
 * `pethMainPseOperStatus` (RFC 3621) → the stored alarm string.
 *
 * `on(1)` the PSE is delivering, `off(2)` it is switched off, `faulty(3)` it
 * has failed.
 *
 * `off(2)` maps to NULL, not "alarm", for the same reason ENTITY-SENSOR's
 * `unavailable(2)` does: a PSE an operator has turned off is a configuration
 * choice, and alarming on it would fire on every switch where PoE is
 * deliberately disabled. Only `faulty(3)` is a failure.
 */
export function pseOperStatusToAlarm(oper: number | null | undefined): string | null {
  if (oper == null) return null;
  if (oper === 1) return "ok";
  if (oper === 3) return "alarm";
  return null; // off(2), and anything undefined by the RFC
}

/**
 * `entPhySensorOperStatus` → the stored alarm string, or null for "no claim".
 *
 * RFC 3433: `ok(1)` the agent can read the sensor, `unavailable(2)` it cannot,
 * `nonoperational(3)` it believes the sensor is broken.
 *
 * The mapping that matters is **`unavailable(2)` → null, not "alarm"**. An
 * empty SFP cage reports unavailable, and a port with no transceiver in it is
 * not a fault — alerting on it would fire on every unused port on the switch.
 * Null means "no reading", which is exactly right and keeps the NULL discipline
 * the alarm metric depends on.
 *
 * Note the resulting semantics differ by source, and deliberately: on the
 * Fortinet path `alarmStatus` is the device's own limit alarm, while here it
 * reports whether the SENSOR is functioning. Both answer "should a human look
 * at this", which is what the metric is for, but a nonoperational optic is a
 * broken/absent sensor rather than a reading outside its limits.
 */
export function entityOperStatusToAlarm(oper: number | null | undefined): string | null {
  if (oper == null) return null;
  if (oper === 1) return "ok";
  if (oper === 3) return "alarm";
  return null; // unavailable(2), and anything undefined by the RFC
}

/**
 * Normalize a FortiGate fgHwSensorEntAlarmStatus integer (0 = no alarm,
 * 1 = alarm) into the stored alarm string. Returns null when the device
 * didn't report a status.
 */
export function normalizeFgAlarmStatus(raw: number | null | undefined): string | null {
  if (raw == null) return null;
  return raw === 0 ? "ok" : "alarm";
}

/**
 * Normalize a FortiOS REST sensor-info alarm field (boolean / 0|1 / string)
 * into the stored alarm string. Returns null when absent.
 */
/**
 * `AssetHardwareSensorSample.alarmStatus` → the 0/1 an automation compares.
 *
 * The column is written exclusively by the two normalizers here, so its domain
 * is exactly `"ok" | "alarm" | null` — but this reads defensively because it
 * also runs over rows written before those normalizers existed.
 *
 * **null means "no reading", and that is load-bearing.** Only the FortiOS REST
 * `sensor-info` and SNMP `fgHwSensorTable` collectors populate the column; the
 * ENTITY-SENSOR-MIB walk and the FortiAP-controller path leave it NULL because
 * those sources publish no alarm bit. Mapping that absence to 0 would be a
 * positive claim of health: it would clear a live alert, and it would make every
 * non-Fortinet sensor in the fleet look actively verified-healthy when nothing
 * ever checked. The engine drops nulls, so those sensors simply produce no
 * readings for this metric.
 */
export function alarmStatusToFlag(raw: string | null | undefined): 0 | 1 | null {
  if (raw == null) return null;
  const s = raw.trim().toLowerCase();
  if (s === "") return null;
  if (s === "ok") return 0;
  if (s === "alarm") return 1;
  // An unrecognized non-empty status is a claim that something is off-nominal,
  // not an absence of data — treat it as the alarm side rather than dropping it.
  return 1;
}

/**
 * Is this stored unit string a Celsius reading we're allowed to convert for
 * display? Mirrors `isCelsiusUnit` in public/js/temp-unit.js — the two must
 * agree, or a sensor reads 71 °F in the browser and 21.7 °C in the alert email
 * about it.
 *
 * Gated on the reading's OWN unit, never on its class: a fan's RPM and a rail's
 * volts flow through untouched, and a row whose unit the device didn't report
 * is left alone rather than guessed at.
 */
export function isCelsiusUnit(unit: string | null | undefined): boolean {
  return typeof unit === "string" && /^\s*(?:°\s*)?c\s*$/i.test(unit);
}

/**
 * Display-only C→F for a server-rendered surface (today: the last-hour sensor
 * chart in an alert email). Storage, rollups and automation THRESHOLDS stay
 * Celsius — this converts at render, exactly like the browser does. Never
 * convert before storage instead: that would silently re-point every
 * temperature automation's threshold (the reason the Manufacturer Profiles
 * Celsius↔Fahrenheit transform was removed, 2026-09-23).
 */
export function convertSensorForDisplay(
  value: number | null | undefined,
  storedUnit: string | null | undefined,
  displayUnit: "c" | "f",
): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (displayUnit !== "f" || !isCelsiusUnit(storedUnit)) return value;
  return value * 9 / 5 + 32;
}

/** The unit LABEL to render for a stored unit — swapped only for Celsius. */
export function sensorDisplayUnit(
  storedUnit: string | null | undefined,
  displayUnit: "c" | "f",
): string {
  if (!isCelsiusUnit(storedUnit)) return storedUnit ?? "";
  return displayUnit === "f" ? "°F" : "°C";
}

export function normalizeRestAlarmStatus(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === "boolean") return raw ? "alarm" : "ok";
  if (typeof raw === "number")  return raw === 0 ? "ok" : "alarm";
  const s = String(raw).trim().toLowerCase();
  if (s === "" ) return null;
  if (s === "0" || s === "false" || s === "ok" || s === "normal" || s === "none") return "ok";
  return "alarm";
}

// ─── ENTITY-MIB entPhysicalTable (RFC 4133) ────────────────────────────────

/** `entPhysicalClass` → our stored class string. RFC 4133's PhysicalClass. */
const ENTITY_PHYSICAL_CLASS: Readonly<Record<number, string>> = {
  1: "other",
  2: "unknown",
  3: "chassis",
  4: "backplane",
  5: "container",
  6: "powerSupply",
  7: "fan",
  8: "sensor",
  9: "module",
  10: "port",
  11: "stack",
  12: "cpu",
};

export function entityPhysicalClassLabel(raw: number | null | undefined): string {
  if (raw == null) return "unknown";
  return ENTITY_PHYSICAL_CLASS[raw] ?? "other";
}

/**
 * Whether an entPhysicalTable row is worth storing as inventory.
 *
 * A chassis publishes a row for every container, port and sensor it has —
 * hundreds of rows naming nothing an operator could ever replace or RMA. What
 * matters is the field-replaceable units: transceivers, power supplies, fan
 * trays.
 *
 * `entPhysicalIsFRU` is the device's own answer and is trusted when true. The
 * class fallback exists because plenty of agents leave IsFRU false (or omit it)
 * on modules that plainly are replaceable — a `module`-class row with a serial
 * number is an SFP whatever the FRU bit says.
 *
 * `container` is deliberately excluded even though an empty SFP cage is
 * arguably inventory: it carries no serial, no model and no vendor, so a row
 * for it is a row that says nothing.
 */
export function entityPhysicalIsInventory(opts: {
  entClass: string;
  isFru: boolean;
  serialNum?: string | null;
  modelName?: string | null;
}): boolean {
  if (opts.isFru) return true;
  if (opts.entClass === "module" || opts.entClass === "powerSupply" || opts.entClass === "fan") {
    // Keep only rows that actually identify something — a bare class with no
    // serial and no model is scaffolding, not a part.
    return !!(opts.serialNum?.trim() || opts.modelName?.trim());
  }
  return false;
}
