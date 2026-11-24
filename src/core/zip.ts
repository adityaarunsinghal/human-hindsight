import { crc32 } from "node:zlib";
import { generatedFileMode } from "./fsutil.js";

/**
 * core/zip.ts: a store-only zip writer and a matching reader.
 *
 * The GUI's Export all button downloads the rendered subagent tree as one zip,
 * built in memory from the saved suggestion. The tree is a few dozen small
 * text files, so compression buys little; storing them (method 0) keeps the
 * writer to the three record types of the format (local file header, central
 * directory, end of central directory) with no dependency. CRC-32 comes from
 * `zlib.crc32` (Node 22.2 and later; the package requires 22.13).
 *
 * Output is byte-identical for identical input: entries are written in sorted
 * name order with one fixed DOS timestamp (`opts.mtime`, default 1980-01-01
 * 00:00, read in UTC so the time zone does not change the bytes). Names are
 * UTF-8 with general-purpose flag bit 11 set, so non-ASCII names survive.
 * Entries are recorded as made on a Unix host with their file mode in the
 * upper half of the external attributes, so an unzipped `create-bots.sh` is
 * executable just as `--export` writes it ({@link generatedFileMode}).
 * There is no ZIP64: a file of 4 GiB or more, an archive past the 32-bit
 * offsets, or more than 65,535 entries is refused with an error.
 *
 * {@link unzipStore} reads only what {@link zipStore} writes (stored entries,
 * no ZIP64, no encryption). Tests use it, and `--export` uses it to check an
 * archive before reporting success.
 */

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const VERSION = 20;
/** "Version made by": host 3 (Unix) in the high byte, so readers apply the mode bits. */
const MADE_BY_UNIX = (3 << 8) | VERSION;
/** File type bits of a regular file (S_IFREG), stored with the permission bits. */
const REGULAR_FILE = 0o100000;
const UTF8_FLAG = 0x0800;
const MAX_U32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;
const DEFAULT_MTIME = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));

function dosTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107);
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

/** Names must be relative, forward-slash paths with no empty, `.` or `..` segment. */
function checkName(name: string): void {
  if (
    !name ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Refusing an unsafe zip entry name: ${JSON.stringify(name)}`);
  }
}

/**
 * Write a store-only zip of `files` (name to content). `opts.mode` gives each
 * entry's permission bits; the default is {@link generatedFileMode}.
 */
export function zipStore(
  files: ReadonlyMap<string, string | Uint8Array>,
  opts: { mtime?: Date; mode?: (name: string, data: Uint8Array) => number } = {},
): Uint8Array {
  const modeOf = opts.mode ?? ((_name: string, data: Uint8Array) => generatedFileMode(data));
  if (files.size > MAX_ENTRIES) {
    throw new Error(`A zip holds at most ${MAX_ENTRIES} entries without ZIP64; got ${files.size}.`);
  }
  const stamp = dosTime(opts.mtime ?? DEFAULT_MTIME);
  const encoder = new TextEncoder();
  const names = [...files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const name of names) {
    checkName(name);
    const value = files.get(name) ?? "";
    const data = typeof value === "string" ? encoder.encode(value) : value;
    if (data.length > MAX_U32) {
      throw new Error(`"${name}" is 4 GiB or larger; this zip writer has no ZIP64 support.`);
    }
    const nameBytes = encoder.encode(name);
    if (nameBytes.length > 0xffff) throw new Error(`Zip entry name too long: ${name.slice(0, 80)}`);
    const crc = crc32(data) >>> 0;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_SIGNATURE, true);
    lv.setUint16(4, VERSION, true);
    lv.setUint16(6, UTF8_FLAG, true);
    lv.setUint16(8, 0, true); // method: stored
    lv.setUint16(10, stamp.time, true);
    lv.setUint16(12, stamp.date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra length
    local.set(nameBytes, 30);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, CENTRAL_SIGNATURE, true);
    cv.setUint16(4, MADE_BY_UNIX, true); // made by: Unix host, spec 2.0
    cv.setUint16(6, VERSION, true);
    cv.setUint16(8, UTF8_FLAG, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, stamp.time, true);
    cv.setUint16(14, stamp.date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    // extra, comment, disk start, internal attributes: 0
    cv.setUint32(38, ((REGULAR_FILE | (modeOf(name, data) & 0o7777)) << 16) >>> 0, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
    if (offset > MAX_U32) throw new Error("The archive passes 4 GiB; ZIP64 is not supported.");
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  if (offset + centralSize > MAX_U32) {
    throw new Error("The archive passes 4 GiB; ZIP64 is not supported.");
  }
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, END_SIGNATURE, true);
  ev.setUint16(8, names.length, true);
  ev.setUint16(10, names.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Read a store-only zip written by {@link zipStore}. Throws on anything else or on damage. */
export function unzipStore(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let endAt = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === END_SIGNATURE) {
      endAt = i;
      break;
    }
  }
  if (endAt < 0) throw new Error("Not a zip archive: no end of central directory record.");
  const entries = view.getUint16(endAt + 10, true);
  const centralSize = view.getUint32(endAt + 12, true);
  let at = view.getUint32(endAt + 16, true);
  if (at + centralSize > endAt) throw new Error("Damaged zip: central directory out of range.");

  const files = new Map<string, Uint8Array>();
  for (let n = 0; n < entries; n++) {
    if (at + 46 > endAt || view.getUint32(at, true) !== CENTRAL_SIGNATURE) {
      throw new Error("Damaged zip: bad central directory entry.");
    }
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const stored = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (method !== 0 || size !== stored) {
      throw new Error(`Unsupported zip entry "${name}": only stored entries are read.`);
    }
    if (localAt + 30 > bytes.length || view.getUint32(localAt, true) !== LOCAL_SIGNATURE) {
      throw new Error(`Damaged zip: bad local header for "${name}".`);
    }
    const dataAt =
      localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
    if (dataAt + size > bytes.length) throw new Error(`Damaged zip: "${name}" is truncated.`);
    const data = bytes.slice(dataAt, dataAt + size);
    if (crc32(data) >>> 0 !== crc) throw new Error(`Damaged zip: CRC mismatch for "${name}".`);
    if (files.has(name)) throw new Error(`Damaged zip: duplicate entry "${name}".`);
    files.set(name, data);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}
