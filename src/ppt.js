// PowerPoint 97–2003 (.ppt, [MS-PPT]) → one section per slide ("--- slide N ---",
// hidden ones marked), then its notes ("--- notes N ---") when they have text.
// Current User stream → offsetToCurrentEdit → the UserEditAtom chain → the persist
// object directory (older edits first, newer entries win) → the live DocumentContainer
// → its SlideListWithText lists (instance 0 slides, 2 notes) → each slide's drawing:
// text of OfficeArtClientTextbox records in drawing order, an OutlineTextRefAtom
// resolved to the slide's outline text. Objects left in the stream by incremental
// saves are never reached. Date, slide number, footer and header placeholders are
// skipped. Anything inconsistent throws: the caller reports a damaged file.
import { readOle } from './containers.js';
import { DoclinesError } from './errors.js';

export const RT = {
  Document: 0x03e8,
  Slide: 0x03ee,
  Notes: 0x03f0,
  NotesAtom: 0x03f1,
  SlidePersistAtom: 0x03f3,
  SlideShowSlideInfoAtom: 0x03f9,
  Drawing: 0x040c,
  PlaceholderAtom: 0x0bc3,
  OutlineTextRefAtom: 0x0f9e,
  TextHeaderAtom: 0x0f9f,
  TextCharsAtom: 0x0fa0,
  TextBytesAtom: 0x0fa8,
  SlideListWithText: 0x0ff0,
  UserEditAtom: 0x0ff5,
  CurrentUserAtom: 0x0ff6,
  PersistDirectoryAtom: 0x1772,
  CryptSession10Container: 0x2f14,
  ClientTextbox: 0xf00d,
  ClientData: 0xf011,
};
// Metacharacter atoms ([MS-PPT] 2.9.47–2.9.52): slide number, date/time, header and
// footer fields; each names the position of its placeholder character in the text.
const METACHAR = new Set([0x0fd8, 0x0ff7, 0x0ff8, 0x0ff9, 0x0ffa, 0x1015]);
// CurrentUserAtom.headerToken of an encrypted file.
export const ENCRYPTED_TOKEN = 0xf3d1c4df;
// PlaceholderEnum: slide images, date, slide number, footer, header.
const FURNITURE = new Set([0x05, 0x07, 0x08, 0x09, 0x0a, 0x0b]);
const MAX_EDITS = 10000;

const fail = (what) => new Error(`PowerPoint Document: ${what}`);

function header(s, off, end = s.length) {
  if (off + 8 > end) throw fail(`record header at ${off} beyond its container`);
  const verInst = s.readUInt16LE(off);
  const h = { ver: verInst & 0xf, inst: verInst >> 4, type: s.readUInt16LE(off + 2), len: s.readUInt32LE(off + 4), off, start: off + 8 };
  h.end = h.start + h.len;
  if (h.end > end) throw fail(`record 0x${h.type.toString(16)} at ${off} overruns its container`);
  return h;
}

function children(s, parent) {
  const out = [];
  for (let p = parent.start; p < parent.end; ) {
    const h = header(s, p, parent.end);
    out.push(h);
    p = h.end;
  }
  return out;
}

/**
 * The live persist object directory: Map persistId → stream offset, from the
 * UserEditAtom at `offsetToCurrentEdit` back to the first edit. Also the
 * DocumentContainer's persist id and, for an encrypted file, the CryptSession10Container's.
 */
export function persistDirectory(s, offsetToCurrentEdit) {
  const edits = [];
  for (let off = offsetToCurrentEdit; ; ) {
    const h = header(s, off);
    if (h.type !== RT.UserEditAtom || h.len < 0x1c) throw fail(`no UserEditAtom at ${off}`);
    const edit = {
      offsetLastEdit: s.readUInt32LE(h.start + 8),
      offsetPersistDirectory: s.readUInt32LE(h.start + 12),
      docPersistIdRef: s.readUInt32LE(h.start + 16),
      encryptSessionPersistIdRef: h.len >= 0x20 ? s.readUInt32LE(h.start + 28) : null,
    };
    edits.push(edit);
    if (edit.offsetLastEdit === 0) break;
    // Each previous edit lies before this one: the chain cannot loop.
    if (edit.offsetLastEdit >= off || edits.length > MAX_EDITS) throw fail('UserEditAtom chain out of order');
    off = edit.offsetLastEdit;
  }
  const persist = new Map();
  for (const edit of edits.reverse()) {
    const dir = header(s, edit.offsetPersistDirectory);
    if (dir.type !== RT.PersistDirectoryAtom) throw fail(`no PersistDirectoryAtom at ${edit.offsetPersistDirectory}`);
    for (let p = dir.start; p < dir.end; ) {
      if (p + 4 > dir.end) throw fail('truncated PersistDirectoryEntry');
      const v = s.readUInt32LE(p);
      const id = v & 0xfffff;
      const count = v >>> 20;
      if (count === 0 || p + 4 + count * 4 > dir.end) throw fail('bad PersistDirectoryEntry');
      for (let k = 0; k < count; k++) persist.set(id + k, s.readUInt32LE(p + 4 + k * 4));
      p += 4 + count * 4;
    }
  }
  const current = edits.at(-1);
  return { persist, docPersistIdRef: current.docPersistIdRef, encryptSessionPersistIdRef: current.encryptSessionPersistIdRef };
}

const charsOf = (s, h) => (h.type === RT.TextCharsAtom ? s.toString('utf16le', h.start, h.end - (h.len % 2)) : s.toString('latin1', h.start, h.end));

// A text body: the characters of its TextCharsAtom/TextBytesAtom records without the
// metacharacters; \r ends a paragraph, \v is a line break inside one.
class Body {
  constructor() {
    this.raw = '';
    this.metas = new Set();
  }

  add(s, h) {
    if (h.type === RT.TextCharsAtom || h.type === RT.TextBytesAtom) this.raw += charsOf(s, h);
    else if (METACHAR.has(h.type) && h.len >= 4) this.metas.add(s.readUInt32LE(h.start));
  }

  text() {
    // Positions count UTF-16 code units.
    const kept = this.metas.size ? this.raw.split('').filter((_, i) => !this.metas.has(i)).join('') : this.raw;
    return kept.replace(/[\r\v]/g, '\n');
  }
}

// Outline text of a SlideListWithText: per SlidePersistAtom, its texts in order.
function slideList(s, list) {
  const out = [];
  let cur = null;
  for (const h of children(s, list)) {
    if (h.type === RT.SlidePersistAtom) {
      if (h.len < 20) throw fail('short SlidePersistAtom');
      cur = { persistIdRef: s.readUInt32LE(h.start), slideId: s.readUInt32LE(h.start + 12), bodies: [] };
      out.push(cur);
    } else if (cur && h.type === RT.TextHeaderAtom) cur.bodies.push(new Body());
    else if (cur?.bodies.length) cur.bodies.at(-1).add(s, h);
  }
  for (const sl of out) sl.texts = sl.bodies.map((b) => b.text());
  return out;
}

// Text bodies of a slide or notes drawing, in drawing order.
function drawingTexts(s, container, outline) {
  const texts = [];
  const used = new Set();
  const visit = (rec) => {
    const kids = children(s, rec);
    let placement = null;
    for (const k of kids) {
      if (k.type === RT.ClientData) {
        for (const c of children(s, k)) if (c.type === RT.PlaceholderAtom && c.len >= 5 && s.readInt32LE(c.start) !== -1) placement = s[c.start + 4];
      }
    }
    for (const k of kids) {
      if (k.type === RT.ClientTextbox) {
        if (placement !== null && FURNITURE.has(placement)) continue;
        let body = null;
        let ref = null;
        for (const c of children(s, k)) {
          if (c.type === RT.TextHeaderAtom) body ??= new Body();
          else if (c.type === RT.OutlineTextRefAtom && c.len >= 4) {
            const i = s.readInt32LE(c.start);
            if (i < 0 || i >= outline.length) throw fail(`OutlineTextRefAtom index ${i} out of range`);
            used.add(i);
            ref = outline[i];
          } else body?.add(s, c);
        }
        const text = (ref ?? '') + (body ? body.text() : '');
        if (body || ref !== null) texts.push(text);
      } else if (k.ver === 0xf && k.type !== RT.ClientData) visit(k);
    }
  };
  visit(container);
  // Outline text no shape refers to.
  outline.forEach((t, i) => {
    if (!used.has(i)) texts.push(t);
  });
  return texts;
}

function recordAt(s, persist, id, type) {
  const off = persist.get(id);
  if (off === undefined) throw fail(`persist object ${id} missing`);
  const h = header(s, off);
  if (h.type !== type) throw fail(`persist object ${id}: record 0x${h.type.toString(16)}, expected 0x${type.toString(16)}`);
  return h;
}

/**
 * Slides of a PowerPoint Document stream: [{ hidden, lines, notes }] in presentation
 * order. `encrypted` is true when the live edit points to a CryptSession10Container.
 */
export function pptSlides(s, offsetToCurrentEdit) {
  const dir = persistDirectory(s, offsetToCurrentEdit);
  if (dir.encryptSessionPersistIdRef !== null && dir.persist.has(dir.encryptSessionPersistIdRef)) {
    const h = header(s, dir.persist.get(dir.encryptSessionPersistIdRef));
    if (h.type === RT.CryptSession10Container) return { encrypted: true, slides: [] };
  }
  const doc = recordAt(s, dir.persist, dir.docPersistIdRef, RT.Document);
  const lists = children(s, doc).filter((h) => h.type === RT.SlideListWithText);
  const slides = slideList(s, lists.find((h) => h.inst === 0) ?? { start: 0, end: 0 });
  const notesList = slideList(s, lists.find((h) => h.inst === 2) ?? { start: 0, end: 0 });
  const notesBySlide = new Map();
  for (const n of notesList) {
    const nc = recordAt(s, dir.persist, n.persistIdRef, RT.Notes);
    const atom = children(s, nc).find((h) => h.type === RT.NotesAtom);
    if (!atom || atom.len < 4) throw fail('notes without NotesAtom');
    notesBySlide.set(s.readUInt32LE(atom.start), drawingTexts(s, nc, n.texts));
  }
  return {
    encrypted: false,
    slides: slides.map((sl) => {
      const sc = recordAt(s, dir.persist, sl.persistIdRef, RT.Slide);
      const info = children(s, sc).find((h) => h.type === RT.SlideShowSlideInfoAtom);
      // SlideShowSlideInfoAtom flags (offset 10): bit 2 is fHidden.
      const hidden = info && info.len >= 12 ? Boolean(s.readUInt16LE(info.start + 10) & 0x0004) : false;
      return { hidden, lines: drawingTexts(s, sc, sl.texts), notes: notesBySlide.get(sl.slideId) ?? [] };
    }),
  };
}

export function extractPpt(buf, ctx) {
  const ole = readOle(buf);
  const cu = ole.read('Current User');
  const stream = ole.read('PowerPoint Document');
  if (!cu || !stream) throw fail('Current User or PowerPoint Document stream missing');
  const atom = header(cu, 0);
  if (atom.type !== RT.CurrentUserAtom || atom.len < 0x14) throw fail('no CurrentUserAtom');
  const encrypted = () => new DoclinesError('encrypted', `encrypted document: password-protected files are not read (${ctx.name})`, { reason: 'encrypted document' });
  if (cu.readUInt32LE(12) === ENCRYPTED_TOKEN) throw encrypted();
  const r = pptSlides(stream, cu.readUInt32LE(16));
  if (r.encrypted) throw encrypted();
  const sections = [];
  r.slides.forEach((sl, i) => {
    const n = i + 1;
    const text = sl.lines.join('\n');
    ctx.guard(text);
    sections.push({ marker: `--- slide ${n}${sl.hidden ? ' (hidden)' : ''} ---`, kind: 'slide', n, label: null, text });
    const notes = sl.notes.join('\n');
    if (notes.trim()) sections.push({ marker: `--- notes ${n} ---`, kind: 'notes', n, label: null, text: notes });
  });
  return { sections };
}
