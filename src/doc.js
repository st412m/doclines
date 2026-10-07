// Word 97–2003 (.doc) → text with word-extractor. Its own final clean-up step is
// replaced before the library loads: the stock one maps cell marks to tabs (a table
// cell then cannot be told from a tab) and turns the optional hyphen (0x1F) into the
// word "undefined" (no entry in its replacement table, word-extractor 1.0.4).
// The replacement keeps the library's field handling.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const filters = require('word-extractor/lib/filters.js');

// One table row as word-extractor hands it over: cells end with 0x07, the row-end
// paragraph is already a "\n". The row starts after the last paragraph mark before
// its first cell mark.
function rowLine(seg) {
  const first = seg.indexOf('\x07');
  if (first < 0) return seg;
  const start = seg.lastIndexOf('\r', first) + 1;
  const cells = seg.slice(start).split('\x07');
  if (cells.at(-1).trim() === '') cells.pop();
  return seg.slice(0, start) + cells.map((c) => c.replace(/[\r\x0b\x0c]/g, ' ').replace(/\s+/g, ' ').trim()).join(' | ');
}

export function cleanWordText(s) {
  // Fields: \x13 instructions \x14 result \x15 → result; nested fields, innermost first.
  for (let prev = null; prev !== s; ) {
    prev = s;
    s = s.replace(/\x13[^\x13\x14\x15]*\x14?([^\x13\x14\x15]*)\x15/g, '$1');
  }
  return s
    .split('\n')
    .map(rowLine)
    .join('\n')
    .replace(/\x1f/g, '')
    .replace(/\x1e/g, '‑')
    .replace(/[\r\x0b\x0c]/g, '\n')
    .replace(/[\x00-\x08\x0e-\x1d]/g, '');
}

filters.clean = cleanWordText;
const WordExtractor = require('word-extractor');

/** Returns sections: body, then footnotes and endnotes after a marker line. */
export async function extractDoc(buf) {
  const d = await new WordExtractor().extract(buf);
  const raw = { filterUnicode: false }; // the default folds dashes and curly quotes to ASCII
  return [
    { marker: null, text: d.getBody(raw) },
    { marker: '--- footnotes ---', kind: 'footnotes', text: d.getFootnotes(raw) },
    { marker: '--- endnotes ---', kind: 'endnotes', text: d.getEndnotes(raw) },
  ].filter((s, i) => i === 0 || s.text.trim() !== '');
}
