// FictionBook 2 (FictionBook.xsd 2.0) → first lines: book title and authors from
// title-info; each top-level section of the main body as "--- chapter N: <title> ---";
// a body named "notes" as a trailing "--- notes ---" section. Paragraphs, subtitles,
// poems (stanza lines), citations, epigraphs, text authors, empty lines and tables
// (row by row); note references and binary data (images) are skipped. Also FB2 in a
// ZIP that holds just that file. Charset: BOM, else the XML declaration, else UTF-8.
import { markerLabel } from './normalize.js';
import { joinCells } from './sheet.js';
import { decodeXml, parseXml } from './xml.js';
import { Zip } from './zip.js';

// FictionBook elements are matched by local name: files with and without the
// FictionBook namespace are both common.
const el = (c, local) => typeof c === 'object' && c !== null && (local === undefined || c.local === local);
const kidsOf = (e, local) => (e?.children ?? []).filter((c) => el(c, local));
const first = (e, local) => kidsOf(e, local)[0] ?? null;

function inline(e) {
  let s = '';
  for (const c of e.children ?? []) {
    if (typeof c === 'string') s += c;
    else if (c.local === 'a' && c.attrs.get('|type') === 'note') continue;
    else if (c.local === 'image') continue;
    else s += inline(c);
  }
  return s;
}

const collapse = (s) => s.replace(/\s+/g, ' ').trim();

function blocks(e, out) {
  for (const c of e.children ?? []) {
    if (!el(c)) continue;
    switch (c.local) {
      case 'p':
      case 'subtitle':
      case 'v':
      case 'text-author':
      case 'date':
        out.push(collapse(inline(c)));
        break;
      case 'empty-line':
        out.push('');
        break;
      case 'table':
        for (const tr of kidsOf(c, 'tr')) {
          const line = joinCells((tr.children ?? []).filter((x) => el(x, 'td') || el(x, 'th')).map((x) => collapse(inline(x))));
          if (line !== null) out.push(line);
        }
        break;
      case 'image':
      case 'binary':
        break;
      default:
        // title, epigraph, cite, poem, stanza, section, annotation: their blocks.
        blocks(c, out);
    }
  }
  return out;
}

const titleOf = (section) => collapse(kidsOf(first(section, 'title'), 'p').map(inline).join(' ') || inline(first(section, 'title') ?? { children: [] }));

export function extractFb2(buf, ctx) {
  let bytes = buf;
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    const zip = new Zip(buf, { maxDocBytes: ctx.maxDocBytes });
    const entry = zip.names.find((n) => !n.endsWith('/'));
    bytes = entry ? zip.read(entry) : null;
    if (!bytes) throw new Error('no FB2 entry');
  }
  const { text, charset } = decodeXml(bytes, ctx.name);
  const doc = parseXml(text);
  const book = (doc.children ?? []).find((c) => el(c, 'FictionBook'));
  if (!book) throw new Error('no FictionBook root');
  const info = first(first(book, 'description'), 'title-info');
  const bookTitle = collapse(inline(first(info, 'book-title') ?? { children: [] }));
  const authors = kidsOf(info, 'author').map((a) => {
    const parts = ['first-name', 'middle-name', 'last-name'].map((k) => collapse(inline(first(a, k) ?? { children: [] }))).filter(Boolean);
    return parts.length ? parts.join(' ') : collapse(inline(first(a, 'nickname') ?? { children: [] }));
  });
  const head = [bookTitle, ...authors].filter(Boolean);
  const sections = [];
  let preface = [];
  let n = 0;
  const notes = [];
  for (const body of kidsOf(book, 'body')) {
    if (body.attrs.get('|name') === 'notes') {
      blocks(body, notes);
      continue;
    }
    for (const c of body.children ?? []) {
      if (!el(c)) continue;
      if (c.local === 'section') {
        n++;
        const title = titleOf(c);
        const lines = blocks(c, []);
        for (const l of lines) ctx.guard(l);
        sections.push({ marker: title ? `--- chapter ${n}: ${markerLabel(title)} ---` : `--- chapter ${n} ---`, kind: 'chapter', n, label: title || null, text: lines.join('\n') });
      } else if (c.local === 'title') {
        // The body title usually repeats the book title, already the first line.
        const t = blocks(c, []);
        if (collapse(t.join(' ')) !== bookTitle) preface.push(...t);
      } else preface.push(...blocks({ children: [c] }, []));
    }
  }
  preface = [...head, ...preface];
  const out = [{ marker: null, text: preface.join('\n') }, ...sections];
  if (notes.join('').trim()) out.push({ marker: '--- notes ---', kind: 'notes', n: null, label: null, text: notes.join('\n') });
  return { charset, sections: out };
}
