// ODT/OTT (OpenDocument text) → the body, then footnotes and endnotes as trailing
// sections after "--- footnotes ---" / "--- endnotes ---", as for DOC.
import { odfEncryptedFull } from './formats.js';
import { OdfText } from './odf.js';
import { NS, decodeXml, find, parseXml } from './xml.js';
import { Zip, ZipError } from './zip.js';

export function extractOdt(buf, ctx) {
  const zip = new Zip(buf, { maxDocBytes: ctx.maxDocBytes });
  if (odfEncryptedFull(zip)) throw new ZipError('encrypted', 'manifest:encryption-data');
  const content = zip.read('content.xml');
  if (!content) throw new Error('no content.xml');
  const doc = parseXml(decodeXml(content).text);
  const body = find(doc, NS.office, 'text');
  if (!body) throw new Error('no office:text');
  const odf = new OdfText();
  const lines = odf.blocks(body, []);
  if (odf.capped) ctx.warn('repeated table rows or cells written out at most 1000 times');
  const sections = [{ marker: null, text: lines.join('\n') }];
  if (odf.notes.footnote.join('').trim()) sections.push({ marker: '--- footnotes ---', kind: 'footnotes', text: odf.notes.footnote.join('\n') });
  if (odf.notes.endnote.join('').trim()) sections.push({ marker: '--- endnotes ---', kind: 'endnotes', text: odf.notes.endnote.join('\n') });
  return { sections };
}
