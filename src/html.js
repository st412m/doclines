// HTML → plain lines. Charset: BOM → HTTP Content-Type (fetched pages) → <meta> →
// UTF-8. Scripts, styles, comments and the head (except the title, kept as the first
// line) are dropped; block elements and <br> break lines; a table row is one line
// with cells joined by " | ".
import { Parser } from 'htmlparser2';
import { DoclinesError } from './errors.js';
import { decoderForLabel } from './windows-1252.js';

// Node built without full ICU has only UTF-8/UTF-16 decoders.
export const LEGACY_DECODERS = (() => {
  try {
    new TextDecoder('windows-1251');
    return true;
  } catch {
    return false;
  }
})();

const UTF8_LABELS = new Set(['utf-8', 'utf8', 'unicode-1-1-utf-8']);

// A decoder for a WHATWG label, or null for an unknown one. A known legacy label on a
// Node without legacy decoders is refused rather than decoded as mojibake.
export function decoderFor(label, name) {
  const l = label.trim().toLowerCase();
  try {
    return decoderForLabel(l);
  } catch {
    if (!LEGACY_DECODERS && !UTF8_LABELS.has(l)) {
      throw new DoclinesError('unsupported', `charset ${l} is not available in this Node build (it needs full ICU) (${name})`, { reason: 'charset not available' });
    }
    return null;
  }
}

function charsetOf(contentType) {
  const m = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType ?? '');
  return m ? m[1] : null;
}

const META_RE = /<meta\b[^>]*?\bcharset\s*=\s*["']?\s*([A-Za-z0-9._:-]+)/i;

export function decodeHtml(buf, { contentType = null, name = 'input' } = {}) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), charset: 'utf-8' };
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), charset: 'utf-16le' };
  if (buf[0] === 0xfe && buf[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), charset: 'utf-16be' };
  const candidates = [charsetOf(contentType), META_RE.exec(buf.subarray(0, 4096).toString('latin1'))?.[1]];
  for (const label of candidates) {
    if (!label) continue;
    let dec = decoderFor(label, name);
    if (!dec) continue;
    // A page cannot declare itself UTF-16 from inside an ASCII-compatible byte stream.
    if (dec.encoding.startsWith('utf-16')) dec = new TextDecoder('utf-8');
    return { text: dec.decode(buf), charset: dec.encoding };
  }
  return { text: new TextDecoder('utf-8').decode(buf), charset: 'utf-8' };
}

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'math']);
// Elements that may sit in <head>; any other opening tag means the body has started.
const HEAD_ONLY = new Set(['title', 'meta', 'link', 'base', 'script', 'style', 'noscript', 'template']);
const PRE = new Set(['pre', 'textarea', 'listing', 'plaintext', 'xmp']);
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'center', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'html',
  'legend', 'li', 'main', 'menu', 'nav', 'ol', 'option', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'tfoot', 'thead',
  'title', 'tr', 'ul', 'textarea', 'listing', 'plaintext', 'xmp',
]);
const WS = /[ \t\n\r\f]+/g;
// A row this long, or one holding a nested table, is layout, not data: its cells are
// emitted as lines in reading order.
const LAYOUT_ROW_CHARS = 2000;

class Sink {
  constructor() {
    this.lines = [];
    this.cur = '';
    this.pre = false;
    this.hasTable = false;
  }

  text(t, pre) {
    if (!pre) {
      this.cur += t;
      return;
    }
    const parts = t.split('\n');
    parts.forEach((p, i) => {
      if (i > 0) this.flush(true);
      this.cur += p;
      this.pre = true;
    });
  }

  flush(force = false) {
    const line = this.pre ? this.cur.replace(/\s+$/, '') : this.cur.replace(WS, ' ').trim();
    if (line !== '' || force) this.lines.push(line);
    this.cur = '';
    this.pre = false;
  }

  push(line) {
    this.flush();
    this.lines.push(line);
  }

  all() {
    this.flush();
    return this.lines;
  }
}

// `title: false` leaves the <title> out (EPUB chapters carry their own heading).
export function htmlToText(html, { title: withTitle = true } = {}) {
  const doc = new Sink();
  const sinks = [doc];
  const tables = []; // { row: [Sink] | null, sink: the sink holding the table }
  let skip = 0;
  let pre = 0;
  let inTitle = false;
  let inHead = false;
  let title = '';
  const sink = () => sinks.at(-1);

  const endCell = () => {
    const t = tables.at(-1);
    if (t && sinks.at(-1) !== t.sink && t.row?.includes(sinks.at(-1))) sinks.pop();
  };
  const endRow = () => {
    const t = tables.at(-1);
    if (!t?.row) return;
    endCell();
    const cells = t.row.map((c) => c.all());
    t.row = null;
    const flat = cells.map((ls) => ls.filter((l) => l !== '').join(' ').replace(/ {2,}/g, ' '));
    if (flat.every((c) => c === '')) return;
    const layout = cells.length === 1 || t.cellsWithTables || flat.reduce((s, c) => s + c.length, 0) > LAYOUT_ROW_CHARS;
    t.cellsWithTables = false;
    if (layout) for (const ls of cells) for (const l of ls) t.sink.push(l);
    else t.sink.push(flat.join(' | '));
  };

  const parser = new Parser(
    {
      onopentag(name) {
        if (skip) {
          if (SKIP.has(name)) skip++;
          return;
        }
        if (SKIP.has(name)) {
          skip++;
          return;
        }
        if (name === 'title') {
          inTitle = true;
          return;
        }
        if (name === 'head') {
          inHead = true;
          return;
        }
        if (inHead) {
          if (HEAD_ONLY.has(name)) return;
          inHead = false;
        }
        if (name === 'br') {
          sink().flush(true);
          return;
        }
        if (name === 'table') {
          const s = sink();
          s.flush();
          if (tables.length && s !== tables.at(-1).sink) tables.at(-1).cellsWithTables = true;
          tables.push({ row: null, sink: s, cellsWithTables: false });
          return;
        }
        const t = tables.at(-1);
        if (t && name === 'tr') {
          endRow();
          t.row = [];
          return;
        }
        if (t && (name === 'td' || name === 'th')) {
          endCell();
          if (!t.row) t.row = [];
          const c = new Sink();
          t.row.push(c);
          sinks.push(c);
          return;
        }
        if (PRE.has(name)) pre++;
        if (BLOCK.has(name)) sink().flush();
      },
      onclosetag(name) {
        if (skip) {
          if (SKIP.has(name)) skip--;
          return;
        }
        if (name === 'title') {
          inTitle = false;
          return;
        }
        if (name === 'head') {
          inHead = false;
          return;
        }
        if (name === 'table' && tables.length) {
          endRow();
          tables.pop();
          return;
        }
        const t = tables.at(-1);
        if (t && name === 'tr') return endRow();
        if (t && (name === 'td' || name === 'th')) return endCell();
        if (PRE.has(name)) pre = Math.max(0, pre - 1);
        if (BLOCK.has(name)) sink().flush();
      },
      ontext(data) {
        if (skip) return;
        if (inTitle) {
          title += data;
          return;
        }
        if (inHead) return;
        sink().text(data, pre > 0);
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  while (tables.length) {
    endRow();
    tables.pop();
  }
  const lines = doc.all();
  const t = title.replace(WS, ' ').trim();
  if (t && withTitle) lines.unshift(t);
  return lines.join('\n');
}

/** { heading, title }: the text of the first <h1>–<h3> and of <title>, whitespace collapsed, or null. */
export function htmlHeadings(html) {
  let heading = null;
  let title = '';
  let inTitle = false;
  let depth = 0;
  let skip = 0;
  let cur = '';
  const parser = new Parser(
    {
      onopentag(name) {
        if (SKIP.has(name)) skip++;
        else if (name === 'title') inTitle = true;
        else if (heading === null && /^h[1-3]$/.test(name)) depth++;
      },
      onclosetag(name) {
        if (SKIP.has(name)) skip = Math.max(0, skip - 1);
        else if (name === 'title') inTitle = false;
        else if (depth && /^h[1-3]$/.test(name) && --depth === 0) {
          const h = cur.replace(WS, ' ').trim();
          if (h) heading = h;
          cur = '';
        }
      },
      ontext(data) {
        if (skip) return;
        if (inTitle) title += data;
        else if (depth) cur += data;
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  return { heading, title: title.replace(WS, ' ').trim() || null };
}
