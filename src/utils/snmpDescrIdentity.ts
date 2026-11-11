/**
 * src/utils/snmpDescrIdentity.ts
 *
 * Read a vendor's OWN documented sysDescr format.
 *
 * `utils/snmpIdentity.ts` deliberately refused to derive a model from
 * sysDescr, and the reason it gave is still right: that object is free text,
 * so a cross-vendor regex ("the token after the vendor word is the model") is
 * the kind of inference that is correct often enough to look correct and
 * silently wrong the rest of the time.
 *
 * This file is the narrow version of that job, and the difference is where the
 * knowledge comes from. Some vendors publish a FIXED, delimited sysDescr whose
 * fields are positional by specification — an AXIS camera answers
 *
 *   `; AXIS M2036-LE; Bullet Camera; 10.12.114; Oct 03 2022 14:20; 7EC.1; 1`
 *
 * which is model, product type, firmware, build date and hardware id in that
 * order, on every AXIS device. Reading that is not a guess; it is parsing a
 * format. So the rule mirrors the enterprise table next door: **a vendor is in
 * here only when its layout is known, and a string that does not match the
 * layout yields nothing rather than a partial guess.**
 *
 * Three consequences worth stating:
 *
 *  - **Every parser ANCHORS on the vendor token, it does not count from the
 *    left.** AXIS puts an operator-settable free-text name in field 1 — empty
 *    on a factory-fresh camera, the device's name once someone sets it — so
 *    "field 3 is the firmware" is wrong on exactly the devices an operator has
 *    already touched. Anchoring on `AXIS <model>` and walking right is stable
 *    across both.
 *  - **A field is claimed only when it is SHAPED like what it should be.** The
 *    firmware slot has to look like a version, or `osVersion` stays empty. A
 *    vendor that reorders its own format across a firmware generation then
 *    yields less detail, never wrong detail.
 *  - **Only fields Polaris can store are parsed.** The build date and the
 *    hardware id (`7EC.1`) are real and identify a board revision, but there
 *    is no Asset column for either and `AssetPhysicalEntity` is ENTITY-MIB's,
 *    populated by a different walk. Parsing them here would produce a value
 *    whose only consumer is this comment.
 */

/** What a vendor's own sysDescr format can tell us, beyond the raw text. */
export interface SysDescrDetail {
  /** The vendor, spelled the way this file's parser owns it. */
  manufacturer?: string;
  /** Model as the device states it, vendor token stripped ("M2036-LE"). */
  model?: string;
  /** Firmware version — Asset.osVersion is "OS or firmware version". */
  osVersion?: string;
  /**
   * The vendor's own words for what the device IS ("Bullet Camera"). Not an
   * Asset column: it rides the scan hit so the Results step can name the
   * device in one short line instead of printing the whole sysDescr, and so
   * the asset-type match rules see it as a fact of its own.
   */
  productType?: string;
  /**
   * Serial number, only where the format states it AND it is the device's own
   * (business rule 161: an APC card's `SN:` is the PDU's only on a PDU, whose
   * card is built in). Through `usableSerialOrNull` at the projection (rule 84).
   */
  serialNumber?: string;
}

/** Longest model / product-type string kept. Bounds a malformed descr. */
const MAX_FIELD = 64;

/** A version-shaped firmware string: 10.12.114, 5.55.4.1, 11.11. */
const VERSION_RE = /^\d+(?:\.\d+){1,4}$/;

/** Collapse whitespace, bound length, and drop an empty result. */
function field(raw: string | undefined): string | undefined {
  if (raw == null) return undefined;
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s) return undefined;
  return s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) : s;
}

/**
 * AXIS Communications — cameras, encoders, door controllers, speakers.
 *
 * `[<device name>]; AXIS <model>; <product type>; <firmware>; <build date>;
 *  <hardware id>; <n>`
 *
 * Anchored on the `AXIS <model>` field because field 1 is the operator's own
 * device name and is empty until someone sets it.
 */
function parseAxis(fields: string[]): SysDescrDetail | undefined {
  const at = fields.findIndex((f) => /^AXIS\s+\S/i.test(f.trim()));
  if (at < 0) return undefined;

  const model = field(fields[at].trim().replace(/^AXIS\s+/i, ""));
  if (!model) return undefined;

  const out: SysDescrDetail = { manufacturer: "Axis Communications", model };

  // The product type sits immediately right of the model. Guard against a
  // version landing here (a firmware generation that drops the type field)
  // rather than storing "10.12.114" as what the device is.
  const type = field(fields[at + 1]);
  if (type && !VERSION_RE.test(type)) out.productType = type;

  // Firmware: the field after the type when there was one, else the next
  // field — so a descr with no product type still yields a version.
  for (const candidate of [fields[at + 2], fields[at + 1]]) {
    const v = field(candidate);
    if (v && VERSION_RE.test(v)) { out.osVersion = v; break; }
  }

  return out;
}

/**
 * APC / Schneider Electric Network Management Card (NMC1, NMC2, NMC3).
 *
 * `APC Web/SNMP Management Card (MB:v4.2.9 PF:v1.5.1.1 PN:apc_hw21_aos_1.5.1.1.bin
 *  AF1:v1.2.0.4 AN1:apc_hw21_rpdu2g_1.2.0.4.bin MN:AP8870 HR:03 SN: ZA2406030655
 *  MD:02/10/2024)`, optionally followed by `(Embedded PowerNet SNMP Agent …)`.
 *
 * KEY:value tokens inside the first parentheses, read by KEY, not position:
 * MB boot monitor, PF the card's OS (AOS), PN its image, AF1 / AN1 the
 * application firmware and image (`rpdu2g`, `sumx` …), MN model, HR hardware
 * revision, SN serial (note the space after the colon), MD manufacture date.
 *
 * **Whose identity MN / SN are is the sysObjectID's call (business rule 161).**
 * They describe the CARD. On a rack PDU the card is built in, so they are the
 * PDU's own; in a UPS's SmartSlot (AP9630 / AP9631 / AP9640 / AP9641) they are
 * the add-on card's, and storing them would call a Smart-UPS an "AP9631" and
 * give every UPS the card's serial. APC registers each product under
 * `318.1.3.<family>`, and `318.1.3.4` is `masterSwitch` — every rack PDU
 * generation (rPDU, rPDU2, sPDU, ePDU …). Model and serial are claimed only
 * under that branch; anywhere else, or with no sysObjectID at all, the parse
 * yields the firmware alone.
 *
 * Firmware is PF, the card's operating system (AOS), falling back to AF1 when
 * a card states no platform. Not the application version: the asset page
 * prints OS / Firmware as `[os, osVersion]`, and a FortiGate fingerprints an
 * APC card's OS as "APC AOS" — AF1 there would read "APC AOS 1.2.0.4", a
 * version AOS never had. The application version stays verbatim in the raw
 * sysDescr on the source row.
 */
const APC_NMC_ANCHOR = /^\s*APC Web\/SNMP Management Card\s*\(([^)]*)\)/i;

/** PowerNet-MIB `masterSwitch` — the rack-PDU product family, card built in. */
const APC_PDU_ARC = /^\.?1\.3\.6\.1\.4\.1\.318\.1\.3\.4(\.|$)/;

/** `KEY:value` tokens; a key whose value is blank takes the next non-key token. */
function apcTokens(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const words = body.split(/\s+/).filter(Boolean);
  const KEY = /^([A-Z]{1,3}\d?):(.*)$/;
  for (let i = 0; i < words.length; i++) {
    const m = KEY.exec(words[i]);
    if (!m) continue;
    let value = m[2];
    if (!value && i + 1 < words.length && !KEY.test(words[i + 1])) value = words[++i];
    if (value && !out.has(m[1])) out.set(m[1], value);
  }
  return out;
}

/** "v1.2.0.4" → "1.2.0.4" when version-shaped, else undefined. */
function apcVersion(raw: string | undefined): string | undefined {
  const v = field(raw?.replace(/^v/i, ""));
  return v && VERSION_RE.test(v) ? v : undefined;
}

function parseApcNmc(raw: string, sysObjectId: string | undefined): SysDescrDetail | undefined {
  const m = APC_NMC_ANCHOR.exec(raw);
  if (!m) return undefined;
  const t = apcTokens(m[1]);

  const out: SysDescrDetail = { manufacturer: "APC" };
  const fw = apcVersion(t.get("PF")) ?? apcVersion(t.get("AF1"));
  if (fw) out.osVersion = fw;

  if (sysObjectId && APC_PDU_ARC.test(sysObjectId.trim())) {
    out.productType = "Rack PDU";
    // A model is a part number: one token, letters and digits. Anything else
    // is a card that reordered its own format, and yields no model.
    const model = field(t.get("MN"));
    if (model && /^[A-Z0-9][A-Z0-9-]{2,}$/i.test(model)) out.model = model;
    const serial = field(t.get("SN"));
    if (serial && /^[A-Z0-9]{6,}$/i.test(serial)) out.serialNumber = serial;
  }
  return out;
}

/**
 * The vendors whose sysDescr layout is known.
 *
 * AXIS and APC, both confirmed against real hardware. That is the whole
 * admission criterion — adding a vendor is adding an entry once its layout is
 * documented, and a vendor whose format is merely *probably* like these does
 * not belong in the table. The `test` is a cheap pre-filter; the parser still
 * has to find its own anchor. `sysObjectId` is offered to every parser, for a
 * format whose fields mean different things on different products (APC).
 */
const VENDOR_DESCR_PARSERS: readonly {
  vendor: string;
  test: RegExp;
  parse: (raw: string, sysObjectId: string | undefined) => SysDescrDetail | undefined;
}[] = [
  {
    vendor: "Axis Communications",
    test: /(^|;)\s*AXIS\s+\S/i,
    // Every AXIS layout is semicolon-delimited.
    parse: (raw) => (raw.includes(";") ? parseAxis(raw.split(";")) : undefined),
  },
  { vendor: "APC", test: APC_NMC_ANCHOR, parse: parseApcNmc },
];

/**
 * Parse a sysDescr through its vendor's own format, when we know it.
 *
 * `sysObjectId` is optional and only ever NARROWS what a parser claims: APC's
 * model and serial need it (rule 161), and a caller that cannot supply it gets
 * the firmware alone.
 *
 * Pure, never throws, and `undefined` for everything else — which is most
 * devices, and is the point: a caller that gets nothing back is left with
 * exactly the identity it had before this file existed.
 */
export function parseVendorSysDescr(
  sysDescr: string | undefined,
  sysObjectId?: string | null,
): SysDescrDetail | undefined {
  if (!sysDescr) return undefined;
  const raw = String(sysDescr);

  for (const entry of VENDOR_DESCR_PARSERS) {
    if (!entry.test.test(raw)) continue;
    const detail = entry.parse(raw, sysObjectId ?? undefined);
    // A vendor that matched the pre-filter but not its own layout yields
    // nothing — deliberately not `{ manufacturer }` alone, which would claim
    // the vendor off a string we just failed to read.
    if (detail && (detail.model || detail.osVersion)) return detail;
  }
  return undefined;
}

// ─── Adopting what the format said onto a stored asset ──────────────────────

/**
 * How the reading reaches the Asset row, and why nothing here decides it.
 *
 * This file used to own that decision: `decideDescrAdoption` compared the
 * parse against the stored columns and returned the fields to write. It was
 * retired when the reading became a real `AssetSource` row (`snmp-sysdescr`),
 * because the decision it was making is the one `utils/assetProjection.ts`
 * already makes for every other source — by PRIORITY, across all of them at
 * once. Two places answering "may this overwrite that?" is how a fleet ends
 * up with two writers trading values every cycle.
 *
 * The priority list ranks this source directly above `fortigate-endpoint`:
 * a device's own SNMP self-report beats a gate's DHCP fingerprint (which
 * answers "ip camera"), and loses to an agent, Arc, vCenter or MDM reading
 * the running system from inside it.
 *
 * What survives here is the cheap gate below — the question the monitor path
 * asks before doing any I/O at all.
 */

/**
 * Did the device's answer change since we last recorded it?
 *
 * The comparison the monitor path gates on, and it deliberately compares two
 * RECORDINGS rather than a recording against the Asset columns. A device
 * whose model a higher-priority source legitimately owns (an in-guest agent,
 * Arc, Intune) disagrees with those columns on every single pass — so gating
 * on the columns would re-write and re-project forever to arrive at the same
 * answer. Gating on "what the device said last time" converges whoever wins.
 *
 * Field-wise rather than JSON-wise: key order and absent-vs-null are not
 * changes, and a stringify comparison would call them one.
 */
export function sameDescrObserved(
  prev: Record<string, unknown> | null | undefined,
  next: Record<string, unknown>,
): boolean {
  if (!prev) return false;
  const read = (o: Record<string, unknown>, k: string): string | null => {
    const v = o[k];
    return typeof v === "string" && v.trim() ? v : null;
  };
  for (const k of ["manufacturer", "model", "osVersion", "productType", "serialNumber", "sysObjectId", "sysDescr"]) {
    if (read(prev, k) !== read(next, k)) return false;
  }
  return true;
}

/**
 * How often a device's identity is re-read, in seconds.
 *
 * Ten minutes: identity changes when someone swaps hardware or applies
 * firmware, so the reading is worth having promptly but is nowhere near a
 * per-minute question. It also bounds the cost — the read rides the
 * response-time probe's existing GET as one extra varbind, so at a 60s
 * cadence this is one varbind in ten rather than one per probe, and the DB
 * work behind it happens only when the answer actually changed.
 */
export const DESCR_READ_INTERVAL_SEC = 600;

/**
 * Is the sysDescr identity read due for an asset?
 *
 * NULL means never read, which is due — so every existing asset picks up its
 * identity on the next probe after deploy and then settles onto the cadence.
 * A stamp in the future (clock skew, a restored backup) reads as due rather
 * than parking the asset until the clock catches up.
 */
export function descrReadDue(
  lastDescrAt: Date | null | undefined,
  now: Date = new Date(),
  intervalSec: number = DESCR_READ_INTERVAL_SEC,
): boolean {
  if (!lastDescrAt) return true;
  const age = now.getTime() - lastDescrAt.getTime();
  if (!Number.isFinite(age)) return true;
  return age < 0 || age >= intervalSec * 1000;
}
