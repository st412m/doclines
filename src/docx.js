// DOCX/DOCM/DOTX/DOTM → HTML (mammoth) → the HTML extractor, which gives table rows as
// lines. mammoth finds the main part through _rels/.rels (officeDocument). Images are
// not read; the "↑" back-links mammoth adds to notes are dropped. mammoth would inflate
// the package with its own ZIP code: every entry is inflated here under the ZIP caps
// (zip.js) and mammoth gets the same entries re-packed stored.
import mammoth from 'mammoth';
import { htmlToText } from './html.js';
import { Zip } from './zip.js';
import { storedZip } from './zip-writer.js';

const noImage = mammoth.images.imgElement(() => ({ src: '' }));
const BACKLINK = / ?<a href="#(?:footnote|endnote|comment)-ref-[^"]*">↑<\/a>/g;

// Calls to mammoth in this thread (tests read it).
export const converted = { count: 0 };

export async function extractDocx(buf, { maxDocBytes } = {}) {
  const zip = new Zip(buf, { maxDocBytes });
  const entries = zip.names.filter((n) => !n.endsWith('/')).map((name) => ({ name, data: zip.read(name) }));
  converted.count++;
  const r = await mammoth.convertToHtml({ buffer: storedZip(entries) }, { convertImage: noImage });
  return [{ marker: null, text: htmlToText(r.value.replace(BACKLINK, '')) }];
}
