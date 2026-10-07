// EPUB 2 and 3 (EPUB 3.3 OCF and package document) → one "--- chapter N: <title> ---"
// section per spine item with text, in spine order (linear="no" items included).
// META-INF/container.xml → the package document → spine → manifest href (relative to
// the package document, percent-decoded) → XHTML through the HTML extractor. Title:
// the first h1–h3, else <title>, else the file name. Navigation documents outside the
// spine are not read. A spine item listed in META-INF/encryption.xml, with any
// algorithm, makes the book encrypted.
import path from 'node:path';
import { epubEncryptedFull } from './formats.js';
import { decodeHtml, htmlHeadings, htmlToText } from './html.js';
import { markerLabel } from './normalize.js';
import { NS, attr, decodeXml, find, findAll, kids, parseXml } from './xml.js';
import { Zip, ZipError } from './zip.js';

const HTML_TYPES = new Set(['application/xhtml+xml', 'text/html']);

function xml(zip, name) {
  const buf = zip.read(name);
  return buf ? parseXml(decodeXml(buf).text) : null;
}

function hrefPath(base, href) {
  let h = href.split('#')[0];
  try {
    h = decodeURIComponent(h);
  } catch {
    // Not percent-encoded as it should be: used as written.
  }
  const p = path.posix.normalize(path.posix.join(path.posix.dirname(base), h));
  return p.startsWith('..') || p.startsWith('/') ? null : p;
}

export function extractEpub(buf, ctx) {
  const zip = new Zip(buf, { maxDocBytes: ctx.maxDocBytes });
  const container = xml(zip, 'META-INF/container.xml');
  const rootfiles = findAll(container, NS.container, 'rootfile');
  const rootfile = rootfiles.find((r) => attr(r, '', 'media-type') === 'application/oebps-package+xml') ?? rootfiles[0];
  const opfPath = attr(rootfile, '', 'full-path');
  const opf = opfPath ? xml(zip, opfPath) : null;
  if (!opf) throw new Error('no package document');
  const items = new Map();
  for (const it of findAll(find(opf, NS.opf, 'manifest'), NS.opf, 'item')) items.set(attr(it, '', 'id'), { href: attr(it, '', 'href') ?? '', type: attr(it, '', 'media-type') ?? '' });
  const spine = kids(find(opf, NS.opf, 'spine'), NS.opf, 'itemref')
    .map((ref) => items.get(attr(ref, '', 'idref')))
    .filter(Boolean)
    .map((item) => ({ ...item, file: hrefPath(opfPath, item.href) }))
    .filter((item) => item.file);
  // A spine item listed in encryption.xml is encrypted whatever the algorithm.
  if (epubEncryptedFull(zip, new Set(spine.map((item) => item.file)))) throw new ZipError('encrypted', 'encryption.xml lists content documents');
  const sections = [];
  let n = 0;
  for (const { file, type } of spine) {
    if (!(HTML_TYPES.has(type) || /\.x?html?$/i.test(file))) continue;
    const bytes = zip.read(file);
    if (!bytes) {
      ctx.warn(`spine item ${file} is missing`);
      continue;
    }
    const html = decodeHtml(bytes, { name: file }).text;
    const text = htmlToText(html, { title: false });
    if (text.trim() === '') continue;
    ctx.guard(text);
    const h = htmlHeadings(html);
    const title = h.heading ?? h.title ?? path.posix.basename(file);
    n++;
    sections.push({ marker: `--- chapter ${n}: ${markerLabel(title)} ---`, kind: 'chapter', n, label: title, text });
  }
  return { sections };
}
