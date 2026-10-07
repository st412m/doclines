// OpenDocument text content (OpenDocument 1.3 Part 3) shared by ODT and ODP:
// paragraphs and headings → lines (white space collapsed as §6.1.2 says), lists, tables
// row by row, text boxes, notes collected for trailing sections. Tracked changes
// (deleted text), annotations and forms are skipped.
import { MAX_REPEAT, joinCells } from './sheet.js';
import { NS, attr, is } from './xml.js';

// Children never read as text.
const SKIP = {
  text: new Set(['tracked-changes', 'sequence-decls', 'variable-decls', 'user-field-decls', 'dde-connection-decls', 'soft-page-break', 'note-citation', 'bookmark', 'bookmark-start', 'bookmark-end', 'reference-mark', 'reference-mark-start', 'reference-mark-end', 'change', 'change-start', 'change-end', 'alphabetical-index-mark', 'toc-mark', 'user-index-mark']),
  office: new Set(['annotation', 'annotation-end', 'forms', 'event-listeners']),
  draw: new Set(['image', 'object', 'object-ole', 'applet', 'plugin', 'page-thumbnail', 'enhanced-geometry', 'glue-point']),
};
// Fields with page furniture: skipped in presentations.
const PRESENTATION_FIELDS = new Set(['page-number', 'page-count', 'date', 'time', 'footer', 'header', 'date-time']);

const nsKey = (el) => {
  for (const k of ['text', 'office', 'draw', 'table', 'presentation', 'style']) if (NS[k].has(el.ns)) return k;
  return null;
};

export class OdfText {
  /** `presentation`: skip page-number/date/footer fields. */
  constructor({ presentation = false } = {}) {
    this.presentation = presentation;
    this.notes = { footnote: [], endnote: [] };
    this.capped = false;
  }

  skipped(el) {
    const k = nsKey(el);
    if (k && SKIP[k]?.has(el.local)) return true;
    if (this.presentation && (NS.text.has(el.ns) || NS.presentation.has(el.ns)) && PRESENTATION_FIELDS.has(el.local)) return true;
    return el.ns === 'http://www.w3.org/2000/svg' || el.ns === 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0';
  }

  /** Block content of `el` → lines pushed to `out`. */
  blocks(el, out) {
    for (const c of el.children ?? []) {
      if (typeof c !== 'object' || this.skipped(c)) continue;
      if (is(c, NS.text, 'p') || is(c, NS.text, 'h')) {
        const extra = [];
        out.push(this.paragraph(c, extra));
        out.push(...extra);
      } else if (is(c, NS.table, 'table')) this.table(c, out);
      else if (is(c, NS.presentation, 'notes')) continue;
      else this.blocks(c, out);
    }
    return out;
  }

  /** One paragraph → its text; text boxes anchored in it go to `extra`. */
  paragraph(p, extra) {
    let out = '';
    let rawSpace = false; // out ends with a space that came from the document's text
    const raw = (s) => {
      for (const ch of s.replace(/[\t\r\n]/g, ' ')) {
        if (ch === ' ') {
          if (out === '' || rawSpace) continue;
          rawSpace = true;
        } else rawSpace = false;
        out += ch;
      }
    };
    const literal = (s) => {
      out += s;
      rawSpace = false;
    };
    const inline = (el) => {
      for (const c of el.children ?? []) {
        if (typeof c === 'string') raw(c);
        else if (this.skipped(c)) continue;
        else if (is(c, NS.text, 's')) literal(' '.repeat(Math.min(Number(attr(c, NS.text, 'c') ?? 1) || 1, 1000)));
        else if (is(c, NS.text, 'tab')) literal('\t');
        else if (is(c, NS.text, 'line-break')) literal('\n');
        else if (is(c, NS.text, 'note')) {
          const body = c.children?.find((k) => is(k, NS.text, 'note-body'));
          const lines = body ? this.blocks(body, []) : [];
          (attr(c, NS.text, 'note-class') === 'endnote' ? this.notes.endnote : this.notes.footnote).push(...lines);
        } else if (is(c, NS.text, 'ruby')) {
          const base = c.children?.find((k) => is(k, NS.text, 'ruby-base'));
          if (base) inline(base);
        } else if (NS.draw.has(c.ns)) this.blocks(c, extra);
        else inline(c);
      }
    };
    inline(p);
    return rawSpace ? out.slice(0, -1) : out;
  }

  /** A table → one line per row, cells joined by " | ". */
  table(t, out) {
    const rows = [];
    const collect = (el) => {
      for (const c of el.children ?? []) {
        if (is(c, NS.table, 'table-row')) rows.push(c);
        else if (is(c, NS.table, 'table-header-rows') || is(c, NS.table, 'table-rows') || is(c, NS.table, 'table-row-group')) collect(c);
      }
    };
    collect(t);
    for (const r of rows) {
      const cells = [];
      for (const c of r.children ?? []) {
        if (!is(c, NS.table, 'table-cell') && !is(c, NS.table, 'covered-table-cell')) continue;
        const repeat = Number(attr(c, NS.table, 'number-columns-repeated') ?? 1) || 1;
        const text = is(c, NS.table, 'covered-table-cell') ? '' : this.blocks(c, []).filter((l) => l.trim() !== '').join(' ').replace(/\s+/g, ' ').trim();
        if (text && repeat > MAX_REPEAT) this.capped = true;
        for (let k = 0; k < (text ? Math.min(repeat, MAX_REPEAT) : Math.min(repeat, 100000)); k++) cells.push(text);
      }
      const line = joinCells(cells);
      if (line === null) continue;
      const repeat = Number(attr(r, NS.table, 'number-rows-repeated') ?? 1) || 1;
      if (repeat > MAX_REPEAT) this.capped = true;
      for (let k = 0; k < Math.min(repeat, MAX_REPEAT); k++) out.push(line);
    }
  }
}
