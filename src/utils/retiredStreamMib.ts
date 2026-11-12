/**
 * The per-stream MIB pins (`responseTimeMibId`, `cpuMemoryMibId`, …) are
 * retired (business rule 170): which MIB a stream reads is decided by the
 * asset's manufacturer profile, never pinned per stream.
 *
 * API clients written against the old contract still send them, and a write
 * endpoint that started answering 400 for a field it accepted yesterday would
 * break those clients for no gain. So each write schema keeps the key but
 * parses it to `undefined`: accepted, never stored (Prisma skips an undefined
 * field, and JSON.stringify drops one from a settings blob).
 */
import { z } from "zod";

export const RETIRED_STREAM_MIB_FIELDS = [
  "responseTimeMibId", "cpuMemoryMibId", "temperatureMibId",
  "interfacesMibId", "lldpMibId", "processesMibId",
] as const;

/** A write-schema field that accepts anything and keeps nothing. */
export const retiredStreamMibField = () => z.unknown().optional().transform((): undefined => undefined);
