// Excel 97–2003 and PowerPoint 97–2003: the BIFF8 and PPT readers, on the fixtures
// and on record streams built in memory.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detect, extract } from '../src/index.js';
import { streamReads } from '../src/containers.js';
import { classify, currentUserState, workbookState } from '../src/formats.js';
import { pptSlides, persistDirectory } from '../src/ppt.js';
import { rkValue, sharedStrings } from '../src/xls.js';
import { fx, fxPath } from './helpers.js';

// ---- XLS ----

test('XLS gives the same lines, markers and sections as XLSX of the same workbook', async () => {
  const xls = await extract(fxPath('text.xls'));
  const xlsx = await extract(fxPath('text.xlsx'));
  assert.deepEqual(xls.lines, xlsx.lines);
  assert.deepEqual(xls.markers, xlsx.markers);
  assert.deepEqual(xls.sections, xlsx.sections);
  assert.ok(xls.lines.includes('[1000] Row one thousand | 36:00:00'));
  assert.deepEqual(xls.warnings.filter((w) => !w.startsWith('heap cap')), ['sheet 1: runs of more than 64 empty cells shown as "…" (1)']);
});

test('big-sst.xls: all 600 shared strings, split across Continue records in both encodings', async () => {
  const r = await extract(fxPath('big-sst.xls'));
  assert.equal(r.lines.length, 600);
  r.lines.forEach((line, i) => {
    const n = String(i).padStart(4, '0');
    assert.ok(line === `[${i + 1}] Latin string number ${n} padded to cross CONTINUE records` || line === `[${i + 1}] Кириллическая строка номер ${n} для границы CONTINUE`, line);
  });
});

const cpart = (...bufs) => Buffer.concat(bufs.map((b) => (typeof b === 'number' ? Buffer.from([b]) : b)));
const u16 = (v) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
};
const u32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
};

test('SST: a string split by Continue restarts with an option byte; runs and phonetic data are skipped across records', () => {
  const parts = [
    // cstTotal, cstUnique; "Hello" whole; "abcdefghij" compressed, split after "abcde".
    cpart(u32(4), u32(4), u16(5), 0x00, Buffer.from('Hello', 'latin1'), u16(10), 0x00, Buffer.from('abcde', 'latin1')),
    // The continuation switches to UTF-16 (option byte 0x01); then "Жук" UTF-16 with one formatting run, split inside the run.
    cpart(0x01, Buffer.from('fghij', 'utf16le'), u16(3), 0x09, u16(1), Buffer.from('Жук', 'utf16le'), Buffer.from([0, 0])),
    // The rest of the run (no option byte: not character data); then a UTF-16 string with phonetic data, split mid-characters.
    cpart(Buffer.from([1, 0]), u16(4), 0x05, u32(3), Buffer.from('Да', 'utf16le')),
    cpart(0x01, Buffer.from('ня', 'utf16le'), Buffer.from([7, 8, 9])),
  ];
  assert.deepEqual(sharedStrings(parts), ['Hello', 'abcdefghij', 'Жук', 'Даня']);
  // UTF-16 continued as compressed.
  assert.deepEqual(sharedStrings([cpart(u32(1), u32(1), u16(4), 0x01, Buffer.from('Яя', 'utf16le')), cpart(0x00, Buffer.from('ab', 'latin1'))]), ['Яяab']);
  assert.throws(() => sharedStrings([cpart(u32(1), u32(2), u16(1), 0x00, Buffer.from('x'))]), /SST data ends early/);
});

test('RkNumber: integers, IEEE high bits, the x100 flag', () => {
  assert.equal(rkValue((3605044 << 2) | 0x02), 3605044);
  assert.equal(rkValue((-40 << 2) | 0x02), -40);
  assert.equal(rkValue((15 << 2) | 0x03), 0.15);
  assert.equal(rkValue(0x3ff80000), 1.5);
  assert.equal(rkValue(0x3ff80000 | 0x01), 0.015);
});

test('detection by stream heads: BIFF version, FilePass after BOF or WriteProtect; CurrentUserAtom version and token', () => {
  const bof = (vers) => cpart(u16(0x0809), u16(16), u16(vers), u16(5), Buffer.alloc(12));
  assert.equal(workbookState(cpart(bof(0x0600), u16(0x00e1), u16(0))), 'xls');
  assert.equal(workbookState(cpart(bof(0x0600), u16(0x002f), u16(2), u16(1))), 'encrypted');
  assert.equal(workbookState(cpart(bof(0x0600), u16(0x0086), u16(0), u16(0x002f), u16(2), u16(1))), 'encrypted');
  assert.equal(workbookState(cpart(bof(0x0500), u16(0x00e1), u16(0))), 'older');
  assert.equal(workbookState(Buffer.from('not a workbook')), 'damaged');
  const cu = (token, docVer = 0x03f4, major = 3) => cpart(u16(0), u16(0x0ff6), u32(0x14), u32(0x14), u32(token), u32(0), u16(0), u16(docVer), major, 0, u16(0));
  assert.equal(currentUserState(cu(0xe391c05f)), 'ppt');
  assert.equal(currentUserState(cu(0xf3d1c4df)), 'encrypted');
  assert.equal(currentUserState(cu(0xe391c05f, 0x03f3)), 'older');
  assert.equal(currentUserState(cu(0xe391c05f, 0x03f4, 2)), 'older');
  assert.equal(currentUserState(null), 'older');
});

test('the calling thread reads only OLE directories and stream heads: no whole stream', async () => {
  streamReads.length = 0;
  for (const [file, format] of [['text.xls', 'xls'], ['text.ppt', 'ppt'], ['msg-simple.msg', 'msg'], ['text.doc', 'doc']]) {
    assert.equal(classify(fx(file), 'ole', file, ''), format);
    assert.equal((await detect(fxPath(file))).format, format);
  }
  assert.deepEqual(streamReads, []);
});

// ---- PPT ----

test('PPT gives the same slides, hidden slide and notes as PPTX and ODP', async () => {
  const ppt = await extract(fxPath('text.ppt'));
  const pptx = await extract(fxPath('text.pptx'));
  assert.deepEqual(ppt.markers.map((m) => m.text), pptx.markers.map((m) => m.text));
  assert.deepEqual(
    ppt.sections.map((s) => [s.kind, s.n]),
    pptx.sections.map((s) => [s.kind, s.n]),
  );
  // The table of the deck is separate text shapes in PPT: one cell per line.
  const words = (r) => r.lines.join(' ').split(/[\s|]+/).filter(Boolean);
  assert.deepEqual(words(ppt), words(pptx));
  assert.ok(!ppt.lines.includes('*'), 'slide number metacharacters are not text');
});

// A PowerPoint Document stream built record by record.
function rec(type, data = Buffer.alloc(0), { ver = 0, inst = 0 } = {}) {
  const h = Buffer.alloc(8);
  h.writeUInt16LE((inst << 4) | ver, 0);
  h.writeUInt16LE(type, 2);
  h.writeUInt32LE(data.length, 4);
  return Buffer.concat([h, data]);
}
const box = (type, kids, inst = 0) => rec(type, Buffer.concat(kids), { ver: 0xf, inst });
const textBox = (text, extra = []) => box(0xf004, [box(0xf00d, [rec(0x0f9f, u32(4)), rec(0x0fa0, Buffer.from(text, 'utf16le')), ...extra])]);
const slide = (shapes, { hidden = false } = {}) => {
  const info = Buffer.alloc(16);
  info.writeUInt16LE(hidden ? 0x0005 : 0x0001, 10);
  return box(0x03ee, [rec(0x03ef, Buffer.alloc(24), { ver: 2 }), rec(0x03f9, info), box(0x040c, [box(0xf002, [box(0xf003, shapes)])])]);
};
const persistAtom = (persistId, slideId) => rec(0x03f3, cpart(u32(persistId), u32(0), u32(0), u32(slideId), u32(0)));
const doc = (slides, notes = [], outline = []) =>
  box(0x03e8, [rec(0x03e9, Buffer.alloc(40), { ver: 1 }), box(0x0ff0, [...slides.map(([p, id], i) => Buffer.concat([persistAtom(p, id), ...(outline[i] ?? [])]))]), box(0x0ff0, notes.map(([p, id]) => persistAtom(p, id)), 2)]);
const persistDir = (entries) => rec(0x1772, Buffer.concat(entries.map(([id, off]) => cpart(u32((1 << 20) | id), u32(off)))));
const userEdit = (lastEdit, dirOffset, { crypt = null } = {}) =>
  rec(0x0ff5, cpart(u32(0), u16(0), 0, 3, u32(lastEdit), u32(dirOffset), u32(1), u32(20), u16(1), u16(0), ...(crypt === null ? [] : [u32(crypt)])));

/** Lays records out in order; `refs` returns offsets of named records. */
function stream(parts) {
  const offsets = {};
  const bufs = [];
  let off = 0;
  for (const [name, make] of parts) {
    const b = typeof make === 'function' ? make(offsets) : make;
    offsets[name] = off;
    bufs.push(b);
    off += b.length;
  }
  return { s: Buffer.concat(bufs), offsets };
}

test('PPT: an incremental save leaves dead slides in the stream; only the live persist directory is read', () => {
  const { s, offsets } = stream([
    ['doc1', doc([[2, 256], [3, 257]])],
    ['slideA', slide([textBox('Slide A')])],
    ['slideB', slide([textBox('Dead slide B')])],
    ['dir1', (o) => persistDir([[1, o.doc1], [2, o.slideA], [3, o.slideB]])],
    ['edit1', (o) => userEdit(0, o.dir1)],
    // The second save: slide B deleted, slide C added, a new DocumentContainer.
    ['doc2', doc([[2, 256], [4, 258]])],
    ['slideC', slide([textBox('Slide C')], { hidden: true })],
    ['dir2', (o) => persistDir([[1, o.doc2], [4, o.slideC]])],
    ['edit2', (o) => userEdit(o.edit1, o.dir2)],
  ]);
  assert.ok(s.includes(Buffer.from('Dead slide B', 'utf16le')), 'the dead slide is still in the stream');
  const r = pptSlides(s, offsets.edit2);
  assert.deepEqual(r.slides.map((x) => [x.hidden, x.lines]), [[false, ['Slide A']], [true, ['Slide C']]]);
  // From the first edit only, the old directory is live.
  assert.deepEqual(pptSlides(s, offsets.edit1).slides.map((x) => x.lines[0]), ['Slide A', 'Dead slide B']);
  const dir = persistDirectory(s, offsets.edit2);
  assert.deepEqual([dir.persist.get(1), dir.persist.get(3), dir.persist.get(4)], [offsets.doc2, offsets.slideB, offsets.slideC]);
});

test('PPT: outline text by OutlineTextRefAtom, metacharacters dropped, furniture placeholders skipped, notes by slide id', () => {
  const placeholder = (placement) => box(0xf011, [rec(0x0bc3, cpart(u32(0), placement, 0, 0, 0))]);
  const outline = [[rec(0x0f9f, u32(0)), rec(0x0fa0, Buffer.from('Outline title', 'utf16le'))]];
  const shapes = [
    box(0xf004, [box(0xf00d, [rec(0x0f9e, u32(0))])]),
    textBox('Page *\rnext\vline', [rec(0x0fd8, u32(5))]),
    box(0xf004, [placeholder(0x08), box(0xf00d, [rec(0x0f9f, u32(4)), rec(0x0fa8, Buffer.from('7', 'latin1'))])]),
    box(0xf004, [box(0xf00d, [rec(0x0f9f, u32(4)), rec(0x0fa8, Buffer.from('bytes text', 'latin1'))])]),
  ];
  const notes = box(0x03f0, [rec(0x03f1, cpart(u32(256), u16(0), u16(0)), { ver: 1 }), box(0x040c, [box(0xf002, [box(0xf003, [textBox('The notes')])])])]);
  const { s, offsets } = stream([
    ['doc', doc([[2, 256]], [[3, 256]], outline)],
    ['slide', slide(shapes)],
    ['notes', notes],
    ['dir', (o) => persistDir([[1, o.doc], [2, o.slide], [3, o.notes]])],
    ['edit', (o) => userEdit(0, o.dir)],
  ]);
  const r = pptSlides(s, offsets.edit);
  assert.deepEqual(r.slides, [{ hidden: false, lines: ['Outline title', 'Page \nnext\nline', 'bytes text'], notes: ['The notes'] }]);
});

test('PPT: a CryptSession10Container in the live edit is encrypted; an inconsistent stream throws', () => {
  const { s, offsets } = stream([
    ['doc', doc([])],
    ['crypt', box(0x2f14, [rec(0x0001, Buffer.alloc(8))])],
    ['dir', (o) => persistDir([[1, o.doc], [9, o.crypt]])],
    ['edit', (o) => userEdit(0, o.dir, { crypt: 9 })],
  ]);
  assert.equal(pptSlides(s, offsets.edit).encrypted, true);
  // A previous-edit offset that does not go back: a loop.
  const loop = stream([['doc', doc([])], ['dir', (o) => persistDir([[1, o.doc]])], ['edit', (o) => userEdit(o.dir + 100, o.dir)]]);
  assert.throws(() => pptSlides(loop.s, loop.offsets.edit), /chain out of order|no UserEditAtom/);
  assert.throws(() => pptSlides(s, 3), /PowerPoint Document/);
  // A slide persist id with no directory entry.
  const missing = stream([['doc', doc([[5, 256]])], ['dir', (o) => persistDir([[1, o.doc]])], ['edit', (o) => userEdit(0, o.dir)]]);
  assert.throws(() => pptSlides(missing.s, missing.offsets.edit), /persist object 5 missing/);
});
