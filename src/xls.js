// Excel 97–2003 workbooks (.xls, BIFF8, [MS-XLS]) → one section per sheet, rows as in
// xlsx.js. The Workbook stream: the globals substream (BOF, FilePass, CodePage,
// Date1904, Format, XF, BoundSheet8, SST with its Continue records), then one
// substream per sheet at BoundSheet8.lbPlyPos with its cell records. Formulas give
// their cached value (a string result is in the String record that follows).
import { readOle } from './containers.js';
import { DoclinesError } from './errors.js';
import { markerLabel } from './normalize.js';
import { cellText, dateKind, joinCells, numberText, serialText } from './sheet.js';

// Record types ([MS-XLS] 2.3 Record Enumeration).
export const REC = {
  Formula: 0x0006,
  EOF: 0x000a,
  Date1904: 0x0022,
  FilePass: 0x002f,
  Continue: 0x003c,
  CodePage: 0x0042,
  WsBool: 0x0081,
  BoundSheet8: 0x0085,
  MulRk: 0x00bd,
  XF: 0x00e0,
  MergeCells: 0x00e5,
  SST: 0x00fc,
  LabelSst: 0x00fd,
  Number: 0x0203,
  Label: 0x0204,
  BoolErr: 0x0205,
  String: 0x0207,
  RK: 0x027e,
  Format: 0x041e,
  BOF: 0x0809,
};
const BIFF8 = 0x0600;
// BErr ([MS-XLS] 2.5.10 Bes, 2.5.198.2 BErr).
const ERRORS = { 0x00: '#NULL!', 0x07: '#DIV/0!', 0x0f: '#VALUE!', 0x17: '#REF!', 0x1d: '#NAME?', 0x24: '#NUM!', 0x2a: '#N/A', 0x2b: '#GETTING_DATA' };

const fail = (what) => new Error(`Workbook stream: ${what}`);

/** Records from `off` up to and including the EOF of the substream: [{ type, data, off }]. */
export function records(wb, off = 0, { untilEof = true } = {}) {
  const out = [];
  for (let p = off; p < wb.length; ) {
    if (p + 4 > wb.length) throw fail(`truncated record header at ${p}`);
    const type = wb.readUInt16LE(p);
    const len = wb.readUInt16LE(p + 2);
    if (p + 4 + len > wb.length) throw fail(`record 0x${type.toString(16)} at ${p} overruns the stream`);
    out.push({ type, data: wb.subarray(p + 4, p + 4 + len), off: p });
    p += 4 + len;
    if (untilEof && type === REC.EOF) break;
  }
  return out;
}

// A byte reader over a record and its Continue records. A string's characters may be
// split across them: each continuation starts with a fresh option byte (fHighByte).
class Segments {
  constructor(parts) {
    this.parts = parts;
    this.i = 0;
    this.p = 0;
  }

  get left() {
    return this.parts[this.i].length - this.p;
  }

  // Moves to the next part when the current one is used up (between structures).
  boundary() {
    while (this.i < this.parts.length && this.p >= this.parts[this.i].length) {
      this.i++;
      this.p = 0;
    }
    if (this.i >= this.parts.length) throw fail('SST data ends early');
  }

  u8() {
    this.boundary();
    return this.parts[this.i][this.p++];
  }

  u16() {
    return this.u8() | (this.u8() << 8);
  }

  u32() {
    return (this.u16() | (this.u16() << 16)) >>> 0;
  }

  skip(n) {
    while (n > 0) {
      this.boundary();
      const k = Math.min(n, this.left);
      this.p += k;
      n -= k;
    }
  }

  // cch characters, compressed (one byte, high byte 0x00) or UTF-16LE; a Continue in
  // the middle starts with a new option byte.
  chars(cch, high) {
    let s = '';
    let left = cch;
    let first = true;
    while (left > 0) {
      if (this.i >= this.parts.length || this.p >= this.parts[this.i].length) {
        this.i++;
        this.p = 0;
        if (this.i >= this.parts.length) throw fail('SST string ends early');
        high = this.parts[this.i][this.p++] & 0x01;
      } else if (!first && this.left === 0) continue;
      first = false;
      const part = this.parts[this.i];
      const width = high ? 2 : 1;
      const k = Math.min(left, Math.floor((part.length - this.p) / width));
      if (k === 0) throw fail('a double-byte character split across records');
      s += high ? part.toString('utf16le', this.p, this.p + k * 2) : part.toString('latin1', this.p, this.p + k);
      this.p += k * width;
      left -= k;
    }
    return s;
  }
}

/** The shared strings of an SST record and its Continue records (XLUnicodeRichExtendedString). */
export function sharedStrings(parts) {
  const seg = new Segments(parts);
  seg.skip(4); // cstTotal
  const unique = seg.u32();
  const out = [];
  for (let n = 0; n < unique; n++) {
    const cch = seg.u16();
    const flags = seg.u8();
    const runs = flags & 0x08 ? seg.u16() : 0;
    const ext = flags & 0x04 ? seg.u32() : 0;
    out.push(seg.chars(cch, flags & 0x01));
    seg.skip(runs * 4 + ext); // formatting runs and phonetic data
  }
  return out;
}

// XLUnicodeString at `off` (2-byte cch) or ShortXLUnicodeString (1-byte cch).
function xlString(data, off, short = false) {
  const cch = short ? data[off] : data.readUInt16LE(off);
  const p = off + (short ? 1 : 2);
  const high = data[p] & 0x01;
  return high ? data.toString('utf16le', p + 1, p + 1 + cch * 2) : data.toString('latin1', p + 1, p + 1 + cch);
}

// RkNumber: bit 0 fX100, bit 1 fInt, 30 high bits a signed integer or the high bits of an IEEE double.
export function rkValue(rk) {
  let v;
  if (rk & 0x02) v = rk >> 2;
  else {
    const b = Buffer.alloc(8);
    b.writeUInt32LE((rk & 0xfffffffc) >>> 0, 4);
    v = b.readDoubleLE(0);
  }
  return rk & 0x01 ? v / 100 : v;
}

function globals(wb) {
  const recs = records(wb, 0);
  const bof = recs[0];
  if (!bof || bof.type !== REC.BOF || bof.data.length < 4) throw fail('no BOF record');
  if (bof.data.readUInt16LE(0) !== BIFF8) return { older: true };
  const g = { formats: new Map(), xfs: [], sheets: [], strings: [], date1904: false, encrypted: false };
  for (let k = 0; k < recs.length; k++) {
    const { type, data } = recs[k];
    if (type === REC.FilePass) g.encrypted = true;
    else if (type === REC.Date1904) g.date1904 = data.readUInt16LE(0) === 1;
    else if (type === REC.Format) g.formats.set(data.readUInt16LE(0), xlString(data, 2));
    else if (type === REC.XF) g.xfs.push(data.readUInt16LE(2));
    else if (type === REC.BoundSheet8) g.sheets.push({ pos: data.readUInt32LE(0), state: data[4] & 0x03, dt: data[5], name: xlString(data, 6, true) });
    else if (type === REC.SST) {
      const parts = [data];
      while (recs[k + 1]?.type === REC.Continue) parts.push(recs[++k].data);
      g.strings = sharedStrings(parts);
    }
  }
  return g;
}

function sheetRows(wb, sheet, g, ctx, n) {
  const recs = records(wb, sheet.pos);
  if (recs[0]?.type !== REC.BOF) throw fail(`sheet ${n}: no BOF at ${sheet.pos}`);
  const dt = recs[0].data.readUInt16LE(2);
  if (dt !== 0x0010) return null; // chart (0x20) or macro (0x40) sheet: marker only
  // A dialog sheet (WsBool.fDialog) has no cells to read either.
  const ws = recs.find((r) => r.type === REC.WsBool);
  if (ws && ws.data[0] & 0x10) return null;
  const rows = new Map();
  const covered = new Set();
  const kind = (ixfe) => {
    const ifmt = g.xfs[ixfe];
    return ifmt === undefined ? null : dateKind(ifmt, g.formats.has(ifmt) ? g.formats.get(ifmt) : null);
  };
  const number = (v, ixfe) => serialText(v, kind(ixfe), g.date1904) ?? numberText(String(v));
  const put = (rw, col, v) => {
    const t = cellText(v);
    if (!t) return;
    if (!rows.has(rw)) rows.set(rw, new Map());
    rows.get(rw).set(col, t);
  };
  for (let k = 0; k < recs.length; k++) {
    const { type, data } = recs[k];
    switch (type) {
      case REC.LabelSst:
        put(data.readUInt16LE(0), data.readUInt16LE(2), g.strings[data.readUInt32LE(6)] ?? '');
        break;
      case REC.Label:
        put(data.readUInt16LE(0), data.readUInt16LE(2), xlString(data, 6));
        break;
      case REC.Number:
        put(data.readUInt16LE(0), data.readUInt16LE(2), number(data.readDoubleLE(6), data.readUInt16LE(4)));
        break;
      case REC.RK:
        put(data.readUInt16LE(0), data.readUInt16LE(2), number(rkValue(data.readUInt32LE(6) | 0), data.readUInt16LE(4)));
        break;
      case REC.MulRk: {
        const rw = data.readUInt16LE(0);
        const first = data.readUInt16LE(2);
        const count = (data.length - 6) / 6;
        for (let i = 0; i < count; i++) put(rw, first + i, number(rkValue(data.readUInt32LE(4 + i * 6 + 2) | 0), data.readUInt16LE(4 + i * 6)));
        break;
      }
      case REC.BoolErr: {
        const v = data[6];
        put(data.readUInt16LE(0), data.readUInt16LE(2), data[7] ? (ERRORS[v] ?? '#ERR') : v ? 'TRUE' : 'FALSE');
        break;
      }
      case REC.Formula: {
        const rw = data.readUInt16LE(0);
        const col = data.readUInt16LE(2);
        if (data.readUInt16LE(12) !== 0xffff) put(rw, col, number(data.readDoubleLE(6), data.readUInt16LE(4)));
        else if (data[6] === 0x01) put(rw, col, data[8] ? 'TRUE' : 'FALSE');
        else if (data[6] === 0x02) put(rw, col, ERRORS[data[8]] ?? '#ERR');
        else if (data[6] === 0x00) {
          // The String record follows, after any ShrFmla/Array/Table records.
          for (let j = k + 1; j < recs.length && recs[j].type !== REC.EOF; j++) {
            if (recs[j].type === REC.String) {
              put(rw, col, xlString(recs[j].data, 0));
              break;
            }
            if (![0x04bc, 0x0221, 0x0236].includes(recs[j].type)) break;
          }
        }
        break;
      }
      case REC.MergeCells: {
        const count = data.readUInt16LE(0);
        for (let i = 0; i < count; i++) {
          const o = 2 + i * 8;
          const [r0, r1, c0, c1] = [data.readUInt16LE(o), data.readUInt16LE(o + 2), data.readUInt16LE(o + 4), data.readUInt16LE(o + 6)];
          if ((r1 - r0 + 1) * (c1 - c0 + 1) > 1e6) continue;
          for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (r !== r0 || c !== c0) covered.add(`${r}:${c}`);
        }
        break;
      }
      default:
    }
  }
  const lines = [];
  let collapsed = 0;
  for (const rw of [...rows.keys()].sort((a, b) => a - b)) {
    const cells = rows.get(rw);
    for (const c of [...cells.keys()]) if (covered.has(`${rw}:${c}`)) cells.delete(c);
    const line = joinCells(cells, () => collapsed++);
    if (line === null) continue;
    ctx.guard(line);
    lines.push(`[${rw + 1}] ${line}`);
  }
  if (collapsed) ctx.warn(`sheet ${n}: runs of more than 64 empty cells shown as "…" (${collapsed})`);
  return lines.join('\n');
}

export function extractXls(buf, ctx) {
  const ole = readOle(buf);
  const wb = ole.read('Workbook');
  if (!wb) throw fail('no Workbook stream');
  const g = globals(wb);
  if (g.older) throw new DoclinesError('unsupported', `unsupported format: Excel workbook older than Excel 97 (.xls) (${ctx.name})`, { label: 'Excel workbook older than Excel 97 (.xls)', reason: 'unsupported format: Excel workbook older than Excel 97 (.xls)' });
  if (g.encrypted) throw new DoclinesError('encrypted', `encrypted document: password-protected files are not read (${ctx.name})`, { reason: 'encrypted document' });
  const sections = [];
  g.sheets.forEach((sh, i) => {
    const n = i + 1;
    // BoundSheet8.dt 0x06 is a VBA module, not a sheet.
    if (sh.dt === 0x06) return;
    const text = sheetRows(wb, sh, g, ctx, n) ?? '';
    sections.push({ marker: `--- sheet ${n}: ${markerLabel(sh.name)}${sh.state ? ' (hidden)' : ''} ---`, kind: 'sheet', n, label: sh.name, text });
  });
  return { sections };
}
