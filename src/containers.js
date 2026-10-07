// ZIP entry names (detection) and OLE compound files (MS-CFB): the root directory,
// stream heads for detection, whole streams for the extractors. Bounds and cycles are checked
// everywhere; a damaged container throws ContainerError.

export class ContainerError extends Error {}

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;

export function isZip(buf) {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5) && (buf[3] === 4 || buf[3] === 6);
}

function u64(buf, off) {
  const v = buf.readBigUInt64LE(off);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ContainerError('zip64 value out of range');
  return Number(v);
}

function centralNames(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === ZIP_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  let count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if ((count === 0xffff || offset === 0xffffffff) && eocd >= 20 && buf.readUInt32LE(eocd - 20) === ZIP64_LOCATOR) {
    const z = u64(buf, eocd - 20 + 8);
    if (z + 56 > buf.length || buf.readUInt32LE(z) !== ZIP64_EOCD) return null;
    count = u64(buf, z + 32);
    offset = u64(buf, z + 48);
  }
  const names = [];
  let p = offset;
  for (let k = 0; k < count; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== ZIP_CENTRAL) return null;
    const n = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    if (p + 46 + n > buf.length) return null;
    names.push(buf.toString('utf8', p + 46, p + 46 + n));
    p += 46 + n + extra + comment;
  }
  return names;
}

// Fallback for a truncated archive: walk the local headers from the start.
function localNames(buf) {
  const names = [];
  let p = 0;
  while (p + 30 <= buf.length && buf.readUInt32LE(p) === ZIP_LOCAL) {
    const flags = buf.readUInt16LE(p + 6);
    const size = buf.readUInt32LE(p + 18);
    const n = buf.readUInt16LE(p + 26);
    const extra = buf.readUInt16LE(p + 28);
    if (p + 30 + n > buf.length) break;
    names.push(buf.toString('utf8', p + 30, p + 30 + n));
    if (flags & 0x08) break; // sizes follow the data: cannot skip it reliably
    p += 30 + n + extra + size;
  }
  return names;
}

export function zipEntryNames(buf) {
  return centralNames(buf) ?? localNames(buf);
}

// ODF stores an uncompressed "mimetype" entry first.
export function zipMimetype(buf) {
  if (buf.length < 30 || buf.readUInt32LE(0) !== ZIP_LOCAL) return null;
  const method = buf.readUInt16LE(8);
  const size = buf.readUInt32LE(18);
  const n = buf.readUInt16LE(26);
  const extra = buf.readUInt16LE(28);
  if (method !== 0 || buf.toString('latin1', 30, 30 + n) !== 'mimetype' || size > 200) return null;
  const start = 30 + n + extra;
  if (start + size > buf.length) return null;
  return buf.toString('latin1', start, start + size).trim();
}

const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const NOSTREAM = 0xffffffff;

// Names of the streams read whole in this thread, in order (tests read it).
export const streamReads = [];

export function isOle(buf) {
  return buf.length >= 8 && buf.subarray(0, 8).equals(OLE_MAGIC);
}

/**
 * Root-level entries of an OLE compound file. Returns { names: Set of upper-cased
 * names, head(name, n) → Buffer with the first n (<= 64) bytes of that stream, or null,
 * read(name) → the whole stream, or null }.
 */
export function readOle(buf) {
  if (buf.length < 512 || !isOle(buf)) throw new ContainerError('not an OLE compound file');
  const shift = buf.readUInt16LE(0x1e);
  if (shift !== 9 && shift !== 12) throw new ContainerError(`bad sector shift ${shift}`);
  const ss = 1 << shift;
  const miniSize = 1 << buf.readUInt16LE(0x20);
  const nFat = buf.readUInt32LE(0x2c);
  const dirStart = buf.readUInt32LE(0x30);
  const miniCutoff = buf.readUInt32LE(0x38);
  const nSectors = Math.ceil((buf.length - ss) / ss);
  const offsetOf = (s) => {
    if (s >= nSectors) throw new ContainerError(`sector ${s} beyond the end of the file`);
    return (s + 1) * ss;
  };
  const u32 = (off) => (off + 4 <= buf.length ? buf.readUInt32LE(off) : FREESECT);

  // FAT sector list: 109 entries in the header, then the DIFAT chain.
  const fatSectors = [];
  for (let i = 0; i < 109 && fatSectors.length < nFat; i++) {
    const v = buf.readUInt32LE(0x4c + 4 * i);
    if (v !== FREESECT) fatSectors.push(v);
  }
  const seenDifat = new Set();
  for (let d = buf.readUInt32LE(0x44); d !== ENDOFCHAIN && d !== FREESECT && fatSectors.length < nFat; ) {
    if (seenDifat.has(d)) throw new ContainerError('DIFAT loop');
    seenDifat.add(d);
    const off = offsetOf(d);
    for (let j = 0; j < ss / 4 - 1 && fatSectors.length < nFat; j++) {
      const v = u32(off + 4 * j);
      if (v !== FREESECT) fatSectors.push(v);
    }
    d = u32(off + ss - 4);
  }
  const per = ss / 4;
  const fat = new Uint32Array(fatSectors.length * per).fill(FREESECT);
  fatSectors.forEach((s, i) => {
    const off = offsetOf(s);
    for (let j = 0; j < per; j++) fat[i * per + j] = u32(off + 4 * j);
  });
  const chain = (start) => {
    const out = [];
    const seen = new Set();
    for (let s = start; s !== ENDOFCHAIN; s = fat[s]) {
      if (s === FREESECT || s >= fat.length || seen.has(s)) throw new ContainerError('broken sector chain');
      seen.add(s);
      out.push(s);
    }
    return out;
  };

  const entries = [];
  for (const s of chain(dirStart)) {
    const off = offsetOf(s);
    for (let k = 0; k < ss / 128; k++) {
      const e = off + k * 128;
      if (e + 128 > buf.length) break;
      const len = buf.readUInt16LE(e + 0x40);
      entries.push({
        name: len >= 2 && len <= 64 ? buf.toString('utf16le', e, e + len - 2) : '',
        type: buf[e + 0x42],
        left: buf.readUInt32LE(e + 0x44),
        right: buf.readUInt32LE(e + 0x48),
        child: buf.readUInt32LE(e + 0x4c),
        start: buf.readUInt32LE(e + 0x74),
        size: buf.readUInt32LE(e + 0x78),
      });
    }
  }
  const root = entries[0];
  if (!root || root.type !== 5) throw new ContainerError('no root entry');

  // Root children: a red-black tree through left/right siblings.
  const byName = new Map();
  const stack = [root.child];
  const seen = new Set();
  while (stack.length) {
    const i = stack.pop();
    if (i === NOSTREAM || i >= entries.length || seen.has(i)) continue;
    seen.add(i);
    const e = entries[i];
    if (e.type === 1 || e.type === 2) byName.set(e.name.toUpperCase(), e);
    stack.push(e.left, e.right);
  }

  // The whole stream `name`: a regular sector chain, or for a stream under the mini
  // stream cutoff a mini FAT chain inside the mini stream. null when there is no such
  // stream; chains shorter than the stream size, loops and out-of-range sectors throw.
  let miniFat = null;
  let miniStream = null;
  const read = (name) => {
    streamReads.push(name);
    const e = byName.get(name.toUpperCase());
    if (!e || e.type !== 2) return null;
    if (e.size === 0) return Buffer.alloc(0);
    if (e.size >= miniCutoff) {
      const secs = chain(e.start);
      if (secs.length * ss < e.size) throw new ContainerError(`stream ${name} is shorter than its size`);
      return Buffer.concat(secs.slice(0, Math.ceil(e.size / ss)).map((s) => buf.subarray(offsetOf(s), offsetOf(s) + ss))).subarray(0, e.size);
    }
    if (!miniFat) {
      const first = buf.readUInt32LE(0x3c);
      const fatSecs = first === ENDOFCHAIN ? [] : chain(first);
      miniFat = new Uint32Array(fatSecs.length * per);
      fatSecs.forEach((s, i) => {
        const off = offsetOf(s);
        for (let j = 0; j < per; j++) miniFat[i * per + j] = u32(off + 4 * j);
      });
      const rootSecs = root.start === ENDOFCHAIN ? [] : chain(root.start);
      miniStream = Buffer.concat(rootSecs.map((s) => buf.subarray(offsetOf(s), offsetOf(s) + ss))).subarray(0, root.size);
    }
    const parts = [];
    const seenMini = new Set();
    let got = 0;
    for (let s = e.start; got < e.size; s = miniFat[s]) {
      if (s === ENDOFCHAIN || s >= miniFat.length || seenMini.has(s)) throw new ContainerError(`broken mini chain of ${name}`);
      seenMini.add(s);
      const off = s * miniSize;
      if (off + miniSize > miniStream.length && off + (e.size - got) > miniStream.length) throw new ContainerError(`mini sector ${s} beyond the mini stream`);
      parts.push(miniStream.subarray(off, off + miniSize));
      got += miniSize;
    }
    return Buffer.concat(parts).subarray(0, e.size);
  };

  let mini = null;
  const head = (name, n) => {
    const e = byName.get(name.toUpperCase());
    if (!e || e.type !== 2 || n > 64) return null;
    const len = Math.min(n, e.size);
    if (e.size >= miniCutoff) {
      const off = offsetOf(e.start);
      return off + len <= buf.length ? buf.subarray(off, off + len) : null;
    }
    // Small stream: its first mini sector lies in the mini stream, a regular chain
    // from the root entry. n <= 64 bytes never crosses a mini sector.
    mini ??= chain(root.start);
    const pos = e.start * miniSize;
    const sec = mini[Math.floor(pos / ss)];
    if (sec === undefined) return null;
    const off = offsetOf(sec) + (pos % ss);
    return off + len <= buf.length ? buf.subarray(off, off + len) : null;
  };
  return { names: new Set(byName.keys()), head, read };
}
