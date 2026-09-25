import { describe, it, expect } from "vitest";
import {
  CHANGE_TYPES,
  CHANGE_TYPE_ACTIONS,
  CHANGE_TYPE_META,
  ASSET_STATE_FIELDS,
  FIELD_META,
} from "../../src/services/notificationTypes.js";

// The change-trigger vocabulary is three parallel structures: the enum the
// rule schema validates against, the action string the engine's event tail
// matches on, and the label the wizard renders. A key missing from either map
// produces an automation that silently never fires (no action) or an unlabeled
// picker row — neither fails loudly on its own.

describe("change trigger vocabulary", () => {
  it("maps every change type to an action", () => {
    for (const key of CHANGE_TYPES) {
      expect(CHANGE_TYPE_ACTIONS[key], `missing action for "${key}"`).toBeTruthy();
    }
  });

  it("labels every change type for the wizard", () => {
    for (const key of CHANGE_TYPES) {
      expect(CHANGE_TYPE_META[key], `missing label for "${key}"`).toBeTruthy();
    }
  });

  it("maps each change type to a distinct action", () => {
    const actions = CHANGE_TYPES.map((k) => CHANGE_TYPE_ACTIONS[k]);
    expect(new Set(actions).size).toBe(actions.length);
  });

  it("carries no action key that isn't a declared change type", () => {
    const declared = new Set<string>(CHANGE_TYPES);
    for (const key of Object.keys(CHANGE_TYPE_ACTIONS)) {
      expect(declared.has(key), `orphan action key "${key}"`).toBe(true);
    }
  });

  it("keeps the asset.*.changed family pointed at the unconditional events", () => {
    // These five differ from the change.* family: their events are written
    // unconditionally by the write sites (eventLogService builders) rather
    // than through subscription-gated maybeEmitChangeEvents. The picker entry
    // only selects an always-present event, so the action strings must match
    // what those builders emit.
    expect(CHANGE_TYPE_ACTIONS.firmware_changed).toBe("asset.firmware.changed");
    expect(CHANGE_TYPE_ACTIONS.switch_port_changed).toBe("asset.switch_port.changed");
    expect(CHANGE_TYPE_ACTIONS.wireless_ap_changed).toBe("asset.wireless_ap.changed");
    expect(CHANGE_TYPE_ACTIONS.gateway_firewall_changed).toBe("asset.gateway_firewall.changed");
    // Business rule 58 — written by the controller-link sweep.
    expect(CHANGE_TYPE_ACTIONS.fortilink_changed).toBe("asset.fortilink.changed");
  });
});

describe("asset_state field vocabulary", () => {
  it("gives every state field a wizard label", () => {
    // A field in the enum but missing from FIELD_META validates at the API and
    // renders as a blank picker row — the same silent half-shipped state the
    // change-type maps above guard against.
    for (const key of ASSET_STATE_FIELDS) {
      expect(FIELD_META[key], `missing FIELD_META for "${key}"`).toBeTruthy();
    }
  });

  it("offers the three controller-link values as a closed enum", () => {
    // Closed rather than "dynamic" on purpose: the sweep normalizes every
    // controller word into exactly these three, so a free-text box would let
    // an operator author `== Disconnected` (the RAW FortiOS word, stored for
    // display only) and get a rule that can never match.
    const meta = FIELD_META.fortilinkStatus!;
    expect(meta.kind).toBe("enum");
    expect(meta.values).toEqual(["up", "down", "unknown"]);
  });

  it("keeps controller link separate from monitor status", () => {
    // The two are allowed to disagree — a switch answering ICMP with a dead
    // FortiLink session is the fault the field exists for. Folding "fortilink
    // down" into the monitorStatus vocabulary would erase that.
    expect(FIELD_META.monitorStatus!.values).not.toContain("fortilink_down");
    expect(ASSET_STATE_FIELDS).toContain("fortilinkStatus");
  });

  it("firmwareVsPrimary is a closed three-word enum (business rule 87)", () => {
    // Polaris makes the comparison from parsed versions, so these three are
    // the only readings that exist; a free-text box would let an operator
    // author `== 7.6.8` and get a rule that can never match.
    expect(ASSET_STATE_FIELDS).toContain("firmwareVsPrimary");
    const meta = FIELD_META.firmwareVsPrimary!;
    expect(meta.kind).toBe("enum");
    expect(meta.values).toEqual(["current", "older", "newer"]);
  });
});
