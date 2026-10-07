// PDF → lines per page with pdfjs-dist (legacy build for Node). CMaps and standard
// fonts come from the installed package; without them CJK text comes out empty.
// Lines are rebuilt from text items in content-stream order: hasEOL, a change of
// baseline or a jump back to the left starts a new line; a horizontal gap is a space.
import { createRequire } from 'node:module';
import path from 'node:path';
import { DoclinesError } from './errors.js';
import { encrypted } from './formats.js';
// Before pdfjs is imported (below, on first use): pdfjs must never load @napi-rs/canvas,
// and must keep the soft hyphen (U+00AD) that marks a word broken at a line end.
import './no-canvas.js';
import { softHyphenWarning } from './keep-soft-hyphen.js';

const require = createRequire(import.meta.url);
const PKG_DIR = path.dirname(require.resolve('pdfjs-dist/package.json'));
// pdfjs reads these in Node with fs.readFile(base + name); the base must end in "/".
const dirUrl = (sub) => `${path.join(PKG_DIR, sub).split(path.sep).join('/')}/`;
export const CMAP_URL = dirUrl('cmaps');
export const STANDARD_FONT_DATA_URL = dirUrl('standard_fonts');
// Average non-space characters per page below which the text layer is not usable.
export const MIN_CHARS_PER_PAGE = 20;

let pdfjs = null;

function pageText(items) {
  const lines = [];
  let line = '';
  let last = null;
  const flush = () => {
    lines.push(line);
    line = '';
    last = null;
  };
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    if (it.str !== '') {
      const x = it.transform[4];
      const y = it.transform[5];
      const h = Math.max(Math.abs(it.height) || 0, Math.abs(it.transform[3]) || 0, 1);
      if (last) {
        const lh = Math.max(last.h, h);
        if (Math.abs(y - last.y) > lh * 0.5 || x < last.x - lh * 0.5) flush();
        else {
          const gap = x - (last.x + last.w);
          if (gap > lh * 0.15 && !/\s$/.test(line) && !/^\s/.test(it.str)) line += ' ';
        }
      }
      line += it.str;
      last = { x, y, w: it.width, h };
    }
    if (it.hasEOL) flush();
  }
  if (line !== '') flush();
  return lines.join('\n');
}

/** Returns { sections: [{ marker, page, kind, n, text }], pagesWithoutText: [n], warning }. */
export async function extractPdf(buf, name) {
  pdfjs ??= await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    verbosity: 0,
    isEvalSupported: false,
    useSystemFonts: false,
  });
  try {
    let doc;
    try {
      doc = await task.promise;
    } catch (e) {
      if (e?.name === 'PasswordException') throw encrypted(name, 'pdf');
      if (e?.name === 'InvalidPDFException') throw new DoclinesError('damaged', `damaged PDF: ${name}`, { reason: 'damaged PDF' });
      throw e;
    }
    const sections = [];
    const empty = [];
    let chars = 0;
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const text = pageText(tc.items);
      page.cleanup();
      const n = text.replace(/\s+/g, '').length;
      if (n === 0) empty.push(p);
      chars += n;
      sections.push({ marker: `--- page ${p} ---`, page: p, kind: 'page', n: p, text });
    }
    if (doc.numPages === 0 || chars / doc.numPages < MIN_CHARS_PER_PAGE) {
      throw new DoclinesError('no_text_layer', `no usable text layer (scanned PDF?): ${name}`, { reason: 'no usable text layer (scanned PDF?)' });
    }
    // pdfjs's worker code is loaded by now: report when the soft-hyphen patch is missing.
    return { sections, pagesWithoutText: empty, warning: softHyphenWarning() };
  } finally {
    await task.destroy();
  }
}
