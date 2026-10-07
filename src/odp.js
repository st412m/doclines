// ODP/OTP (OpenDocument presentation) → one section per draw:page ("--- slide N ---",
// hidden ones marked), then its speaker notes ("--- notes N ---") when they have text.
// Hidden = presentation:visibility="hidden" in the page's drawing-page style. Page
// numbers, dates, headers and footers are skipped.
import { odfEncryptedFull } from './formats.js';
import { OdfText } from './odf.js';
import { NS, attr, decodeXml, find, findAll, is, kids, parseXml } from './xml.js';
import { Zip, ZipError } from './zip.js';

// Frames holding page furniture or the slide thumbnail on a notes page.
const FURNITURE = new Set(['page-number', 'date-time', 'footer', 'header', 'page']);

function hiddenStyles(doc) {
  const hidden = new Set();
  for (const s of findAll(doc, NS.style, 'style')) {
    const props = kids(s, NS.style, 'drawing-page-properties')[0];
    if (attr(props, NS.presentation, 'visibility') === 'hidden') hidden.add(attr(s, NS.style, 'name'));
  }
  return hidden;
}

function pageLines(page, odf) {
  const lines = [];
  const walk = (el) => {
    for (const c of el.children ?? []) {
      if (typeof c !== 'object') continue;
      if (is(c, NS.presentation, 'notes') || odf.skipped(c)) continue;
      if (FURNITURE.has(attr(c, NS.presentation, 'class'))) continue;
      if (is(c, NS.draw, 'g') || is(c, NS.draw, 'frame') || is(c, NS.draw, 'a')) walk(c);
      else odf.blocks({ children: [c] }, lines);
    }
  };
  walk(page);
  return lines;
}

function notesLines(page, odf) {
  const notes = kids(page, NS.presentation, 'notes')[0];
  if (!notes) return [];
  const lines = [];
  for (const f of findAll(notes, NS.draw, 'frame')) if (attr(f, NS.presentation, 'class') === 'notes') odf.blocks(f, lines);
  return lines;
}

export function extractOdp(buf, ctx) {
  const zip = new Zip(buf, { maxDocBytes: ctx.maxDocBytes });
  if (odfEncryptedFull(zip)) throw new ZipError('encrypted', 'manifest:encryption-data');
  const content = zip.read('content.xml');
  if (!content) throw new Error('no content.xml');
  const doc = parseXml(decodeXml(content).text);
  const pres = find(doc, NS.office, 'presentation');
  if (!pres) throw new Error('no office:presentation');
  const hidden = hiddenStyles(doc);
  const odf = new OdfText({ presentation: true });
  const sections = [];
  kids(pres, NS.draw, 'page').forEach((page, i) => {
    const n = i + 1;
    const h = hidden.has(attr(page, NS.draw, 'style-name'));
    sections.push({ marker: `--- slide ${n}${h ? ' (hidden)' : ''} ---`, kind: 'slide', n, label: null, text: pageLines(page, odf).join('\n') });
    const notes = notesLines(page, odf);
    if (notes.join('').trim()) sections.push({ marker: `--- notes ${n} ---`, kind: 'notes', n, label: null, text: notes.join('\n') });
  });
  return { sections };
}
