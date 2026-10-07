// Formats: detection, refusals, extractors, normalisation, limits, the extraction
// worker. Fixture files are checked against test/fixtures/formats/fixtures.json.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { isOle, readOle } from '../src/containers.js';
import { cleanWordText } from '../src/doc.js';
import { extract } from '../src/extract.js';
import { classify, looksLikeHtml, sniff } from '../src/formats.js';
import { decodeHtml, htmlToText } from '../src/html.js';
import { normalizeText, toLines } from '../src/normalize.js';
import { CMAP_URL, STANDARD_FONT_DATA_URL } from '../src/pdf.js';
import { rtfToText } from '../src/rtf.js';
import { FIXTURES, fx, fxPath, isRefusal, tmpDir, zip } from './helpers.js';

// ---- every fixture against fixtures.json ----

const entries = Object.entries(FIXTURES).filter(([k]) => !k.startsWith('_'));

test('every file in the fixture folder has a fixtures.json entry', () => {
  const files = fs.readdirSync(path.dirname(fxPath('x'))).filter((f) => f !== 'fixtures.json').sort();
  assert.deepEqual(files, entries.map(([k]) => k).sort());
});

for (const [file, want] of entries) {
  const title = `fixture ${file}: ${want.outcome}${want.code ? ` (${want.code})` : ''}`;
  test(title, async () => {
    const p = fxPath(file);
    if (want.outcome === 'refused') {
      await assert.rejects(extract(p), (e) => {
        assert.equal(e.name, 'DoclinesError', e.stack);
        assert.equal(e.code, want.code, `${file}: ${e.message}`);
        // Entries of the cheap-eyes 0.2 set also keep a substring of the 0.2 reason.
        if (want.reason) assert.ok(e.reason?.includes(want.reason), `${file}: reason ${JSON.stringify(e.reason)}`);
        assert.equal(e.format, want.format);
        if (want.label_contains) assert.ok(e.label?.includes(want.label_contains), e.label);
        return true;
      });
      return;
    }
    const r = await extract(p);
    assert.equal(r.format, want.format);
    const text = r.lines.join('\n');
    const shown = [...r.lines, ...r.markers.map((m) => m.text)].join('\n');
    for (const s of want.must) assert.ok(text.includes(s) || r.markers.some((m) => m.text.includes(s)), `${file}: missing ${JSON.stringify(s)}\n${text}`);
    for (const s of want.must_not) assert.ok(!shown.includes(s), `${file}: must not contain ${JSON.stringify(s)}`);
    if (want.table_row) assert.ok(r.lines.includes(want.table_row), `${file}: no line ${JSON.stringify(want.table_row)}\n${text}`);
    if (want.pages) assert.equal(r.pageStarts.length, want.pages);
    if (want.charset) assert.equal(r.charset, want.charset);
    if (want.sections) assert.deepEqual(r.sections.map((s) => s.kind), want.sections);
    assert.ok(!text.includes('undefined'), `${file}: "undefined" leaked into the text`);
  });
}

test('PDF: only Temperature, −40 and 105 are checked for the table; page marker and page table', async () => {
  const r = await extract(fxPath('text.pdf'));
  const row = r.lines.find((l) => l.includes('Temperature'));
  assert.match(row, /Temperature.*−40.*105/);
  assert.deepEqual(r.markers, [{ at: 0, text: '--- page 1 ---' }]);
  assert.deepEqual(r.pageStarts, [1]);
  assert.deepEqual(r.pagesWithoutText, []);
});

test('pdfjs data folders resolve inside the installed package and end with "/"', () => {
  for (const u of [CMAP_URL, STANDARD_FONT_DATA_URL]) {
    assert.ok(u.endsWith('/'));
    assert.ok(fs.statSync(u).isDirectory(), u);
    assert.match(u, /node_modules\/pdfjs-dist\//);
  }
  assert.ok(fs.readdirSync(CMAP_URL).some((f) => f.endsWith('.bcmap')));
});

// ---- detection and refusals ----

test('sniff: by content first; the extension only breaks ties for HTML', () => {
  assert.equal(sniff(fx('text.pdf'), '.txt'), 'pdf');
  // "%PDF-" later in the first 1 KB counts only for a .pdf file.
  assert.equal(sniff(Buffer.from('# Notes\nsaved as %PDF-1.7 by the scanner\n'), '.md'), 'text');
  assert.equal(sniff(Buffer.concat([Buffer.from('junk\r\n'), fx('text.pdf')]), '.PDF'), 'pdf');
  assert.equal(sniff(fx('text.docx'), '.pdf'), 'zip');
  assert.equal(sniff(fx('text.doc'), '.rtf'), 'ole');
  assert.equal(sniff(fx('lo-export.rtf'), '.doc'), 'rtf');
  assert.equal(sniff(Buffer.from('\uFEFF{\\rtf1 x}'), ''), 'rtf');
  assert.equal(sniff(Buffer.from('plain words'), '.html'), 'html');
  assert.equal(sniff(Buffer.from('plain words'), '.HTM'), 'html');
  assert.equal(sniff(Buffer.from('<!-- saved -->\n<?xml version="1.0"?>\n<!DOCTYPE html><p>x'), '.txt'), 'html');
  assert.equal(sniff(Buffer.from('  <HTML lang="en">'), ''), 'html');
  assert.equal(sniff(Buffer.from('2026-10-02 log line\n'), '.log'), 'text');
  // A markdown note that shows HTML in a code block stays text.
  assert.equal(sniff(Buffer.from('# Notes\n\n```html\n<!doctype html>\n<html>\n```\n'), '.md'), 'text');
  assert.equal(looksLikeHtml(Buffer.from('<!-- never closed')), false);
});

test('"%PDF-" inside a text note is text; a .pdf with junk before the header is still a PDF', async () => {
  const d = tmpDir();
  const note = path.join(d, 'n.md');
  fs.writeFileSync(note, '# Scan log\nexported %PDF-1.7 from the scanner\n');
  const t = await extract(note);
  assert.equal(t.format, 'text');
  assert.deepEqual(t.lines, ['# Scan log', 'exported %PDF-1.7 from the scanner']);
  const pdf = path.join(d, 'junk.pdf');
  fs.writeFileSync(pdf, Buffer.concat([Buffer.from('junk before header\r\n'), fx('text.pdf')]));
  const p = await extract(pdf);
  assert.equal(p.format, 'pdf');
  assert.ok(p.lines.includes('End of fixture.'));
});

const RELS = (target) =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/></Relationships>`;
const TYPES = (part, type) =>
  `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${part}" ContentType="${type}"/></Types>`;

test('ZIP: the format from mimetype, the OOXML main part, or the entry names', () => {
  const cases = [
    [[{ name: '[Content_Types].xml' }, { name: 'word/document.xml' }], 'docx'],
    [[{ name: '_rels/.rels', data: RELS('word/main.xml') }, { name: '[Content_Types].xml', data: TYPES('word/main.xml', 'application/vnd.ms-word.document.macroEnabled.main+xml') }, { name: 'word/main.xml' }], 'docx'],
    [[{ name: '_RELS/.RELS', data: RELS('/book/wb.xml') }, { name: '[content_types].xml', data: TYPES('book/wb.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml') }], 'xlsx'],
    [[{ name: 'xl/workbook.xml' }], 'xlsx'],
    [[{ name: 'ppt/presentation.xml' }], 'pptx'],
    [[{ name: 'mimetype', data: 'application/vnd.oasis.opendocument.spreadsheet' }, { name: 'content.xml' }], 'ods'],
    [[{ name: 'mimetype', data: 'application/vnd.oasis.opendocument.text-template' }, { name: 'content.xml' }], 'odt'],
    [[{ name: 'mimetype', data: 'application/vnd.oasis.opendocument.presentation' }], 'odp'],
    [[{ name: 'mimetype', data: 'application/epub+zip' }], 'epub'],
    [
      [
        { name: 'content.xml' },
        { name: 'META-INF/manifest.xml', data: '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/></manifest:manifest>' },
      ],
      'odt',
    ],
    [[{ name: 'books/' }, { name: 'books/x.FB2' }], 'fb2'],
  ];
  for (const [entries, format] of cases) assert.equal(classify(zip(entries), 'zip', 'f.bin'), format, JSON.stringify(entries.map((e) => e.name)));
});

test('ZIP: recognised and refused, with the labels cheap-eyes 0.2 used where it named them', () => {
  const cases = [
    [[{ name: 'xl/workbook.bin' }], 'Excel binary workbook (.xlsb)'],
    [[{ name: 'mimetype', data: 'application/vnd.oasis.opendocument.graphics' }], 'OpenDocument drawing (.odg)'],
    [[{ name: 'mimetype', data: 'application/vnd.oasis.opendocument.formula' }], 'OpenDocument file'],
    [[{ name: 'mimetype', data: 'application/x-foo' }], 'ZIP archive (application/x-foo)'],
    [[{ name: 'FixedDocSeq.fdseq' }], 'XPS document (.xps, .oxps)'],
    [[{ name: 'Index/Document.iwa' }], 'Apple iWork document (.pages, .numbers, .key)'],
    [[{ name: 'a.fb2' }, { name: 'b.fb2' }], 'ZIP archive'],
    [[{ name: 'notes.txt' }], 'ZIP archive'],
  ];
  for (const [entries, label] of cases) {
    assert.throws(
      () => classify(zip(entries), 'zip', 'f.bin'),
      (e) => e.name === 'DoclinesError' && e.code === 'unsupported' && e.label === label && e.format === null && e.message === `unsupported format: ${label} (f.bin)`,
      label,
    );
  }
});

test('the refusal names the format and the file; the reason keeps the format (as cheap-eyes 0.2)', async () => {
  await assert.rejects(extract(zip([{ name: 'notes.txt' }]), { name: 'a.zip' }), (e) => {
    assert.equal(e.message, 'unsupported format: ZIP archive (a.zip)');
    assert.equal(e.reason, 'unsupported format: ZIP archive');
    assert.equal(e.label, 'ZIP archive');
    return true;
  });
});

test('OLE: encrypted DOCX is EncryptionInfo + EncryptedPackage; encrypted DOC has fEncrypted in FibBase', () => {
  const docx = readOle(fx('refused-encrypted.docx'));
  assert.ok(docx.names.has('ENCRYPTEDPACKAGE') && docx.names.has('ENCRYPTIONINFO'));
  assert.ok(!docx.names.has('WORDDOCUMENT'));
  const doc = readOle(fx('refused-encrypted.doc'));
  assert.ok(doc.names.has('WORDDOCUMENT') && !doc.names.has('ENCRYPTEDPACKAGE'));
  const fib = doc.head('WordDocument', 12);
  assert.equal(fib.readUInt16LE(0), 0xa5ec);
  assert.ok(fib.readUInt16LE(0x0a) & 0x0100, 'fEncrypted');
  const plain = readOle(fx('text.doc')).head('WordDocument', 12);
  assert.equal(plain.readUInt16LE(0x0a) & 0x0100, 0);
  assert.ok(readOle(fx('text.xls')).names.has('WORKBOOK'));
});

test('encrypted OOXML: the format comes from the extension, the package hides it', async () => {
  for (const [name, format] of [['a.docx', 'docx'], ['a.xlsm', 'xlsx'], ['a.pptx', 'pptx'], ['a.bin', null]]) {
    await assert.rejects(extract(fx('refused-encrypted.docx'), { name }), (e) => e.code === 'encrypted' && e.format === format && e.reason === 'encrypted document');
  }
});

test('OLE: a damaged or unknown compound file is refused without a library message', async () => {
  const cut = fx('text.doc').subarray(0, 1024);
  assert.ok(isOle(cut));
  assert.throws(() => classify(cut, 'ole', 'cut.doc'), (e) => e.code === 'damaged' && e.message === 'unsupported format: damaged OLE compound file (cut.doc)');
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'cut.doc'), cut);
  await assert.rejects(extract(path.join(d, 'cut.doc')), (e) => e.name === 'DoclinesError' && !/buffer bounds/i.test(e.message));
});

test('word-extractor clean-up: cell marks → " | ", optional hyphen dropped, fields keep their result', () => {
  assert.equal(cleanWordText('Intro\rA\x07\x07C\x07\nNext\r'), 'Intro\nA |  | C\nNext\n');
  assert.equal(cleanWordText('плани\x1fруем'), 'планируем');
  assert.equal(cleanWordText('see \x13 PAGEREF x \x143\x15 now'), 'see 3 now');
  assert.equal(cleanWordText('a\x13 SET \x13 inner \x14b\x15\x14c\x15d'), 'acd');
});

// ---- RTF ----

const rtf = (s) => rtfToText(Buffer.from(s, 'latin1'));

test("RTF: \\ansicpg default, \\fcharset per font, \\'hh through TextDecoder", () => {
  const r = rtf("{\\rtf1\\ansi\\ansicpg1251{\\fonttbl{\\f0\\fcharset204 A;}{\\f1\\fcharset0 B;}}\\f0 \\'cf\\'f0\\'e8\\'e2\\'e5\\'f2 {\\f1 caf\\'e9}\\par}");
  assert.equal(r.body, 'Привет café');
  // No font table entry: the document code page.
  assert.equal(rtf("{\\rtf1\\ansi\\ansicpg1251 \\'e4\\'e0\\par}").body, 'да');
  // \plain returns to the default font.
  assert.equal(rtf("{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fcharset204 A;}{\\f1\\fcharset0 B;}}\\f1\\'e9\\plain\\'e9\\par}").body, 'éй');
});

test('RTF: \\uN with \\ucN skip counts, negative N, surrogate pairs, \\upr/\\ud', () => {
  assert.equal(rtf('{\\rtf1\\ansi\\uc1 \\u-3913?x\\par}').body, '\uf0b7x');
  assert.equal(rtf('{\\rtf1\\ansi\\uc0\\u1060 b\\par}').body, 'Фb');
  assert.equal(rtf("{\\rtf1\\ansi\\uc2\\u1060\\'3f\\'3fz\\par}").body, 'Фz');
  assert.equal(rtf('{\\rtf1\\ansi\\u-10179?\\u-8704?\\par}').body, '\u{1f600}');
  assert.equal(rtf('{\\rtf1\\ansi{\\upr{A}{\\*\\ud{\\u1060?}}}\\par}').body, 'Ф');
});

test('RTF: skipped destinations, \\bin data, symbols, tables with empty cells, footnotes', () => {
  const r = rtf(
    '{\\rtf1\\ansi{\\info{\\title T}}{\\*\\custom x}{\\stylesheet{\\s0 Normal;}}{\\pict\\bin4 ab}c}visible\\par ' +
      'a\\~b\\-c\\emdash d\\tab e\\par ' +
      '\\trowd\\cellx1\\cellx2\\cellx3\\intbl a\\cell\\cell c\\cell\\row\\pard after{\\v hidden}\\par ' +
      'Body{\\super\\chftn}{\\footnote\\pard\\plain\\chftn Note text.}\\par}',
  );
  assert.deepEqual(toLines(r.body), ['visible', 'a bc—d\te', 'a |  | c', 'after', 'Body']);
  assert.equal(r.footnotes, 'Note text.');
});

test('TextDecoder has the legacy code pages this Node build needs (full ICU)', () => {
  for (const l of ['windows-1251', 'windows-1252', 'windows-1250', 'shift_jis', 'gbk']) assert.equal(new TextDecoder(l).encoding, l);
  assert.equal(new TextDecoder('windows-1251').decode(Uint8Array.from([0xcf, 0xf0, 0xe8])), 'При');
});

// ---- HTML ----

test('HTML charset: BOM → Content-Type → <meta> → UTF-8', () => {
  // "Да" in windows-1251 is C4 E0.
  const page = Buffer.concat([Buffer.from('<meta charset="windows-1251"><p>'), Buffer.from([0xc4, 0xe0]), Buffer.from('</p>')]);
  assert.deepEqual(decodeHtml(page), { text: '<meta charset="windows-1251"><p>Да</p>', charset: 'windows-1251' });
  // Content-Type of a fetched page beats the meta tag.
  assert.equal(decodeHtml(page, { contentType: 'text/html; charset=windows-1252' }).charset, 'windows-1252');
  // A BOM beats both.
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<meta charset="windows-1251"><p>Да</p>')]);
  assert.equal(decodeHtml(bom, { contentType: 'text/html; charset=windows-1252' }).text, '<meta charset="windows-1251"><p>Да</p>');
  // http-equiv form; UTF-16 declared inside the page means UTF-8; unknown label → UTF-8.
  assert.equal(decodeHtml(Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=cp1252">')).charset, 'windows-1252');
  assert.equal(decodeHtml(Buffer.from('<meta charset="utf-16"><p>x</p>')).charset, 'utf-8');
  assert.equal(decodeHtml(Buffer.from('<meta charset="no-such-charset"><p>Да</p>')).text, '<meta charset="no-such-charset"><p>Да</p>');
  assert.equal(decodeHtml(Buffer.from('<p>Да</p>')).charset, 'utf-8');
});

test('HTML structure: title first, scripts/styles/comments/noscript/svg gone, br, pre, entities', () => {
  const html =
    '<html><head><title> T  1 </title><style>p{}</style><script>var s=1</script><meta name="x" content="y"></head><body>' +
    '<p>a<br>b &amp; c&nbsp;d</p><!-- comment --><noscript>ns</noscript><svg><text>svg</text></svg>' +
    '<ul><li>one</li><li>two</li></ul><pre>x\n  y</pre><div>Supplier&rsquo;s <b>bold</b> text</div></body></html>';
  assert.deepEqual(toLines(htmlToText(html)), ['T 1', 'a', 'b & c d', 'one', 'two', 'x', '  y', 'Supplier’s bold text']);
});

test('HTML tables: one row per line, empty cells kept, nested and one-cell tables flatten in reading order', () => {
  assert.deepEqual(toLines(htmlToText('<table><tr><th>A</th><th>B</th><th>C</th></tr><tr><td>1</td><td></td><td><p>3</p><p>4</p></td></tr></table>')), [
    'A | B | C',
    '1 |  | 3 4',
  ]);
  assert.deepEqual(toLines(htmlToText('<table><tr><td>L</td><td><table><tr><td>a</td><td>b</td></tr></table></td></tr></table>after')), ['L', 'a | b', 'after']);
  assert.deepEqual(toLines(htmlToText('<table><tr><td><p>one</p><p>two</p></td></tr></table>')), ['one', 'two']);
  // Implied closing tags.
  assert.deepEqual(toLines(htmlToText('<table><tr><td>x<td>y<tr><td>z<td>w</table>')), ['x | y', 'z | w']);
});

// ---- normalisation ----

test('normalisation: soft hyphen, ZWSP, BOM dropped; NBSP → space; NFC; blank runs collapsed', () => {
  assert.equal(normalizeText('a\u00ADb\u200Bc\uFEFFd\u00A0e\r\nf'), 'abcd e\nf');
  assert.equal(normalizeText('é'), 'é');
  assert.equal(normalizeText('PA3PAБOTAН'), 'PA3PAБOTAН'); // no homoglyph folding
  assert.deepEqual(toLines('\n\na  \n\n\n\nb\n\n'), ['a', '', 'b']);
});

// ---- limits ----

test('maxDocBytes caps the raw document; maxTextBytes caps the extracted text', async () => {
  await assert.rejects(extract(fxPath('text.pdf'), { maxDocBytes: 1000 }), isRefusal('too_large', /^document too large: text\.pdf \(\d+ bytes > maxDocBytes 1000\)$/));
  await assert.rejects(extract(fxPath('utf8.html'), { maxTextBytes: 100 }), isRefusal('text_too_large', /^extracted text too large: utf8\.html/));
  // Raw HTML over maxTextBytes passes when its text fits.
  const d = tmpDir();
  const big = path.join(d, 'big.html');
  fs.writeFileSync(big, `<html><head><script>${'x'.repeat(5000)}</script></head><body><p>small text</p></body></html>`);
  const r = await extract(big, { maxTextBytes: 1000, maxDocBytes: 10000 });
  assert.deepEqual(r.lines, ['small text']);
  // Plain text keeps the 0.1 rule: the file itself against maxTextBytes.
  const txt = path.join(d, 'big.log');
  fs.writeFileSync(txt, 'y'.repeat(1001));
  await assert.rejects(extract(txt, { maxTextBytes: 1000 }), isRefusal('text_too_large', /^file too large: big\.log \(1001 bytes > maxTextBytes 1000\)$/));
  assert.equal((await extract(txt, { maxTextBytes: 1001 })).lines.length, 1);
});
