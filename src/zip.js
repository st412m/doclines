// ZIP archives (PKWARE APPNOTE 6.3.10): the central directory with ZIP64 fields, a
// local-header walk for an archive without one, and entries inflated with
// zlib.inflateRawSync under output caps. Only methods 0 (stored) and 8 (deflate).
// Limits: at most 10 000 entries; the declared and the actual size of each entry, and
// the sum over the entries read, at most `cap` (maxDocBytes * 20, at most 512 MB);
// a declared size that differs from the actual output is a damaged archive. Entry
// names with a leading slash, a drive letter, a backslash or a ".." segment make the
// archive damaged. Errors are ZipError with code 'damaged', 'too_large' or 'encrypted'.
import zlib from 'node:zlib';

export const MAX_ENTRIES = 10000;
export const MAX_TOTAL = 512 * 2 ** 20;
// Container metadata the calling thread may inflate for detection, each capped.
export const META_ENTRIES = new Set([
  'mimetype',
  '[Content_Types].xml',
  '_rels/.rels',
  'META-INF/manifest.xml',
  'META-INF/container.xml',
  'META-INF/encryption.xml',
]);
export const META_MAX = 2 ** 20;

// Names of the entries inflated in this thread, in order (tests read it).
export const inflated = [];

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;

export class ZipError extends Error {
  constructor(code, detail) {
    super(detail);
    this.name = 'ZipError';
    this.code = code;
  }
}

const damaged = (detail) => new ZipError('damaged', detail);

function u64(buf, off) {
  if (off + 8 > buf.length) throw damaged('ZIP64 field beyond the end of the file');
  const v = buf.readBigUInt64LE(off);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw damaged('ZIP64 value out of range');
  return Number(v);
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === EOCD) return i;
  return -1;
}

// Entries from the central directory, or null when there is none to read.
function centralEntries(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) return null;
  let count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if ((count === 0xffff || offset === 0xffffffff) && eocd >= 20 && buf.readUInt32LE(eocd - 20) === ZIP64_LOCATOR) {
    const z = u64(buf, eocd - 20 + 8);
    if (z + 56 > buf.length || buf.readUInt32LE(z) !== ZIP64_EOCD) return null;
    count = u64(buf, z + 32);
    offset = u64(buf, z + 48);
  }
  if (count > MAX_ENTRIES) throw new ZipError('too_large', `${count} entries > ${MAX_ENTRIES}`);
  const entries = [];
  let p = offset;
  for (let k = 0; k < count; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) return null;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    let compSize = buf.readUInt32LE(p + 20);
    let size = buf.readUInt32LE(p + 24);
    const n = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    let localOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + n + extraLen > buf.length) return null;
    const name = buf.toString('utf8', p + 46, p + 46 + n);
    // ZIP64 extended information: only the fields whose 32-bit value is 0xFFFFFFFF, in order.
    if (size === 0xffffffff || compSize === 0xffffffff || localOffset === 0xffffffff) {
      let e = p + 46 + n;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const id = buf.readUInt16LE(e);
        const len = buf.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (size === 0xffffffff) (size = u64(buf, q)), (q += 8);
          if (compSize === 0xffffffff) (compSize = u64(buf, q)), (q += 8);
          if (localOffset === 0xffffffff) localOffset = u64(buf, q);
          break;
        }
        e += 4 + len;
      }
    }
    entries.push({ name, flags, method, compSize, size, localOffset });
    p += 46 + n + extraLen + comment;
  }
  return entries;
}

// A truncated archive: walk the local headers from the start. An entry whose sizes
// follow its data (flag bit 3) has no known size; the walk skips to the next header.
function localEntries(buf) {
  const entries = [];
  let p = 0;
  while (p + 30 <= buf.length && buf.readUInt32LE(p) === LOCAL && entries.length <= MAX_ENTRIES) {
    const flags = buf.readUInt16LE(p + 6);
    const method = buf.readUInt16LE(p + 8);
    const compSize = buf.readUInt32LE(p + 18);
    const size = buf.readUInt32LE(p + 22);
    const n = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    if (p + 30 + n > buf.length) break;
    const name = buf.toString('utf8', p + 30, p + 30 + n);
    const data = p + 30 + n + extraLen;
    if (flags & 0x08) {
      entries.push({ name, flags, method, compSize: null, size: null, localOffset: p });
      const next = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), data);
      if (next < 0) break;
      p = next;
    } else {
      entries.push({ name, flags, method, compSize, size, localOffset: p });
      p = data + compSize;
    }
  }
  if (entries.length > MAX_ENTRIES) throw new ZipError('too_large', `more than ${MAX_ENTRIES} entries`);
  return entries;
}

function checkName(name) {
  if (name.startsWith('/') || name.includes('\\') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) {
    throw damaged(`unsafe entry name ${JSON.stringify(name.slice(0, 100))}`);
  }
}

export class Zip {
  /** `cap`: the largest size of one entry and of all entries read together. */
  constructor(buf, { maxDocBytes = 52428800 } = {}) {
    this.buf = buf;
    this.cap = Math.min(maxDocBytes * 20, MAX_TOTAL);
    this.total = 0;
    const central = centralEntries(buf);
    this.truncated = central === null;
    this.entries = central ?? localEntries(buf);
    this.byName = new Map();
    this.byLower = new Map();
    for (const e of this.entries) {
      checkName(e.name);
      if (!this.byName.has(e.name)) this.byName.set(e.name, e);
      const l = e.name.toLowerCase();
      if (!this.byLower.has(l)) this.byLower.set(l, e);
    }
  }

  get names() {
    return [...this.byName.keys()];
  }

  // `ci`: ASCII case-insensitive part names (OPC); ODF and EPUB names are case-sensitive.
  entry(name, { ci = false } = {}) {
    return (ci ? this.byLower.get(name.toLowerCase()) : this.byName.get(name)) ?? null;
  }

  has(name, opts) {
    return this.entry(name, opts) !== null;
  }

  /** The bytes of one entry, or null when it is missing. `max` caps it below `cap`. */
  read(name, { ci = false, max = this.cap } = {}) {
    const e = this.entry(name, { ci });
    if (!e) return null;
    if (e.flags & 0x01) throw new ZipError('encrypted', `entry ${e.name} is encrypted`);
    if (e.method !== 0 && e.method !== 8) throw damaged(`entry ${e.name}: compression method ${e.method}`);
    const limit = Math.min(max, this.cap);
    if (e.size !== null && e.size > limit) throw new ZipError('too_large', `entry ${e.name}: ${e.size} bytes > ${limit}`);
    const p = e.localOffset;
    if (p + 30 > this.buf.length || this.buf.readUInt32LE(p) !== LOCAL) throw damaged(`entry ${e.name}: no local header`);
    const start = p + 30 + this.buf.readUInt16LE(p + 26) + this.buf.readUInt16LE(p + 28);
    if (e.compSize === null) throw damaged(`entry ${e.name}: size unknown (archive without a central directory)`);
    if (start + e.compSize > this.buf.length) throw damaged(`entry ${e.name}: data beyond the end of the file`);
    const data = this.buf.subarray(start, start + e.compSize);
    const left = this.cap - this.total;
    if (e.size > left) throw new ZipError('too_large', `entries read exceed ${this.cap} bytes`);
    let out;
    if (e.method === 0) out = data;
    else {
      inflated.push(e.name);
      try {
        out = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, e.size) });
      } catch (err) {
        if (err?.code === 'ERR_BUFFER_TOO_LARGE') throw damaged(`entry ${e.name}: larger than its declared ${e.size} bytes`);
        throw damaged(`entry ${e.name}: ${err?.message ?? err}`);
      }
    }
    if (out.length !== e.size) throw damaged(`entry ${e.name}: ${out.length} bytes, declared ${e.size}`);
    this.total += out.length;
    return out;
  }

  /** A container metadata entry (META_ENTRIES), capped at META_MAX; null when missing. */
  readMeta(name, opts) {
    if (!META_ENTRIES.has(name)) throw new Error(`not a metadata entry: ${name}`);
    return this.read(name, { ...opts, max: META_MAX });
  }
}
