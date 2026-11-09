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
 * The vendors whose sysDescr layout is known.
 *
 * One entry, because AXIS is the format in hand and confirmed against real
 * hardware. That is the whole admission criterion — adding a vendor is adding
 * an entry once its layout is documented, and a vendor whose format is merely
 * *probably* like this one does not belong in the table. The `test` is a cheap
 * pre-filter; the parser still has to find its own anchor.
 */
const VENDOR_DESCR_PARSERS: readonly {
  vendor: string;
  test: RegExp;
  parse: (fields: string[]) => SysDescrDetail | undefined;
}[] = [
  { vendor: "Axis Communications", test: /(^|;)\s*AXIS\s+\S/i, parse: parseAxis },
];

/**
 * Parse a sysDescr through its vendor's own format, when we know it.
 *
 * Pure, never throws, and `undefined` for everything else — which is most
 * devices, and is the point: a caller that gets nothing back is left with
 * exactly the identity it had before this file existed.
 */
export function parseVendorSysDescr(sysDescr: string | undefined): SysDescrDetail | undefined {
  if (!sysDescr) return undefined;
  const raw = String(sysDescr);
  if (!raw.includes(";")) return undefined; // Every known format is delimited.

  const fields = raw.split(";");
  for (const entry of VENDOR_DESCR_PARSERS) {
    if (!entry.test.test(raw)) continue;
    const detail = entry.parse(fields);
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
  for (const k of ["manufacturer", "model", "osVersion", "productType", "sysDescr"]) {
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
