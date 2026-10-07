// Containers and safety: ZIP limits, entry names, compression methods, ZIP64 fields;
// what the calling thread may inflate; XML entities; encryption seen by detect.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detect, extract } from '../src/index.js';
import { converted, extractDocx } from '../src/docx.js';
import { classify } from '../src/formats.js';
import { decodeXml, parseXml, textOf } from '../src/xml.js';
import { inflated, META_ENTRIES, META_MAX, Zip, ZipError } from '../src/zip.js';
import { storedZip } from '../src/zip-writer.js';
import { fxPath, isRefusal, zip } from './helpers.js';

const zipError = (code) => (e) => e instanceof ZipError && e.code === code;

// ---- ZIP limits ----

test('ZIP bomb: a declared size over the cap is refused before inflating; a lying one is damaged', () => {
  const big = 'x'.repeat(1_000_000);
  const z = new Zip(zip([{ name: 'a', data: big, deflate: true }]), { maxDocBytes: 10_000 }); // cap 200 000
  assert.equal(z.cap, 200_000);
  const before = inflated.length;
  assert.throws(() => z.read('a'), zipError('too_large'));
  assert.equal(inflated.length, before, 'nothing inflated');
  // Declared 100 bytes, inflates to 1 MB: zlib stops at the declared size.
  const liar = new Zip(zip([{ name: 'a', data: big, deflate: true, size: 100 }]), { maxDocBytes: 10_000 });
  assert.throws(() => liar.read('a'), (e) => zipError('damaged')(e) && /larger than its declared 100 bytes/.test(e.message));
});

test('ZIP: the cap holds for the sum of the entries read; at most 512 MB', () => {
  const part = 'y'.repeat(80_000);
  const z = new Zip(zip(['a', 'b', 'c'].map((name) => ({ name, data: part, deflate: true }))), { maxDocBytes: 10_000 });
  z.read('a');
  z.read('b');
  assert.throws(() => z.read('c'), (e) => zipError('too_large')(e) && /exceed 200000 bytes/.test(e.message));
  assert.equal(new Zip(zip([{ name: 'a' }]), { maxDocBytes: 52428800 }).cap, 512 * 2 ** 20);
});

test('ZIP: more than 10 000 entries is refused', () => {
  const many = Array.from({ length: 10_001 }, (_, i) => ({ name: `f${i}` }));
  assert.throws(() => new Zip(zip(many)), (e) => zipError('too_large')(e) && /10001 entries > 10000/.test(e.message));
  assert.equal(new Zip(zip(many.slice(0, 10_000))).names.length, 10_000);
});

test('ZIP: declared and actual size must match; stored data too', () => {
  const z = new Zip(zip([{ name: 'short', data: 'abcde', size: 10 }, { name: 'def', data: 'abcdef', deflate: true, size: 7 }]));
  assert.throws(() => z.read('short'), (e) => zipError('damaged')(e) && /5 bytes, declared 10/.test(e.message));
  assert.throws(() => z.read('def'), (e) => zipError('damaged')(e) && /6 bytes, declared 7/.test(e.message));
});

test('ZIP: unsafe entry names make the archive damaged', () => {
  for (const name of ['../evil.xml', 'word/../../x', '/abs.xml', 'C:/x', 'dir\\file']) {
    assert.throws(() => new Zip(zip([{ name }])), (e) => zipError('damaged')(e) && /unsafe entry name/.test(e.message), name);
  }
  assert.doesNotThrow(() => new Zip(zip([{ name: 'a..b/c.xml' }])));
});

test('ZIP: methods other than stored and deflate are damaged; an encrypted entry is encrypted', () => {
  const buf = zip([{ name: 'a', data: 'abc' }]);
  const cd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  buf.writeUInt16LE(12, cd + 10); // bzip2
  assert.throws(() => new Zip(buf).read('a'), (e) => zipError('damaged')(e) && /compression method 12/.test(e.message));
  assert.throws(() => new Zip(zip([{ name: 'a', data: 'abc', flags: 1 }])).read('a'), zipError('encrypted'));
});

test('ZIP64: sizes and the local header offset from the extended information field', () => {
  const name = Buffer.from('big.txt');
  const data = Buffer.from('zip64 data');
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt32LE(0xffffffff, 18);
  lh.writeUInt32LE(0xffffffff, 22);
  lh.writeUInt16LE(name.length, 26);
  const extra = Buffer.alloc(4 + 24);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(24, 2);
  extra.writeBigUInt64LE(BigInt(data.length), 4); // uncompressed
  extra.writeBigUInt64LE(BigInt(data.length), 12); // compressed
  extra.writeBigUInt64LE(0n, 20); // local header offset
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt32LE(0xffffffff, 20);
  ch.writeUInt32LE(0xffffffff, 24);
  ch.writeUInt16LE(name.length, 28);
  ch.writeUInt16LE(extra.length, 30);
  ch.writeUInt32LE(0xffffffff, 42);
  const body = Buffer.concat([lh, name, data]);
  const cd = Buffer.concat([ch, name, extra]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(body.length, 16);
  const z = new Zip(Buffer.concat([body, cd, end]));
  assert.equal(z.read('big.txt').toString(), 'zip64 data');
});

test('a truncated ZIP (no central directory) of a known format is damaged; detect says so too', async () => {
  await assert.rejects(extract(fxPath('refused-damaged.docx')), (e) => isRefusal('damaged', /^cannot read refused-damaged\.docx: damaged or unsupported DOCX file$/)(e) && e.format === 'docx');
  const d = await detect(fxPath('refused-damaged.docx'));
  assert.deepEqual([d.format, d.extractable, d.refusal.code], ['docx', false, 'damaged']);
});

test('a ZIP limit inside a document refuses the extraction with the format named', async () => {
  const sheet = '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + '<row><c t="inlineStr"><is><t>x</t></is></c></row>'.repeat(20_000) + '</sheetData></worksheet>';
  const book = zip([
    { name: 'xl/workbook.xml', data: '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', data: sheet, deflate: true },
  ]);
  assert.ok(book.length < 20_000);
  // cap = 1 000 * 20 = 20 000 bytes < the 1 MB sheet.
  await assert.rejects(extract(book, { name: 'b.xlsx', maxDocBytes: 1000 * 20 }), (e) => e.code === 'too_large' && e.format === 'xlsx');
  await assert.rejects(extract(book, { name: 'b.xlsx', maxDocBytes: 20_000 }), (e) => isRefusal('too_large', /^document too large: b\.xlsx \(unpacked entry xl\/worksheets\/sheet1\.xml: \d+ bytes > 400000\)$/)(e) && e.format === 'xlsx');
  const docxBomb = zip([{ name: 'word/document.xml', data: 'z'.repeat(500_000), deflate: true }]);
  await assert.rejects(extract(docxBomb, { name: 'd.docx', maxDocBytes: 10_000 }), (e) => e.code === 'too_large' && e.format === 'docx');
});

// ---- the calling thread: detection only ----

test('classify and detect inflate only container metadata entries, each at most 1 MB', async () => {
  const bigPart = '<w:document>' + 'text '.repeat(400_000) + '</w:document>';
  const docx = zip([
    { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>', deflate: true },
    { name: '_rels/.rels', data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>', deflate: true },
    { name: 'word/document.xml', data: bigPart, deflate: true },
  ]);
  inflated.length = 0;
  assert.equal(classify(docx, 'zip', 'd.docx'), 'docx');
  assert.equal((await detect(docx, { name: 'd.docx' })).format, 'docx');
  assert.ok(inflated.includes('_rels/.rels'));
  assert.ok(!inflated.includes('word/document.xml'));
  assert.ok(inflated.every((n) => META_ENTRIES.has(n)), inflated.join());
  // A metadata entry over 1 MB is not inflated at all.
  const huge = zip([{ name: '[Content_Types].xml', data: ' '.repeat(META_MAX + 1), deflate: true }, { name: 'word/document.xml' }]);
  inflated.length = 0;
  assert.equal(classify(huge, 'zip', 'h.docx'), 'docx');
  assert.deepEqual(inflated, []);
  assert.throws(() => new Zip(docx).readMeta('word/document.xml'), /not a metadata entry/);
});

// ---- XML ----

test('XML: no entity expansion (billion laughs) and no external entities (XXE)', async () => {
  const xml =
    '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;"><!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
    '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:p>x &c; y &xxe; z &amp; &#x41;</text:p></office:text></office:body></office:document-content>';
  const odt = zip([{ name: 'mimetype', data: 'application/vnd.oasis.opendocument.text' }, { name: 'content.xml', data: xml, deflate: true }]);
  const r = await extract(odt, { name: 'e.odt' });
  assert.deepEqual(r.lines, ['x &c; y &xxe; z & A']);
  assert.ok(!r.lines.join('').includes('aaaa'));
  assert.equal(textOf(parseXml('<a>&lt;&#169;&unknown;</a>')), '<©&unknown;');
});

test('XML: the encoding from a BOM, else the declaration, else UTF-8; namespaces by URI, not prefix', () => {
  assert.deepEqual(decodeXml(Buffer.from([0xef, 0xbb, 0xbf, 0x3c, 0x61, 0x2f, 0x3e])), { text: '<a/>', charset: 'utf-8' });
  const cp = Buffer.concat([Buffer.from('<?xml version="1.0" encoding="windows-1251"?><a>'), Buffer.from([0xc4, 0xe0]), Buffer.from('</a>')]);
  assert.equal(textOf(parseXml(decodeXml(cp).text)), 'Да');
  assert.equal(decodeXml(cp).charset, 'windows-1251');
  const doc = parseXml('<x:root xmlns:x="urn:a" xmlns="urn:d"><child y:at="1" plain="2" xmlns:y="urn:b"/></x:root>');
  const root = doc.children[0];
  const child = root.children[0];
  assert.deepEqual([root.ns, root.local, child.ns, child.local], ['urn:a', 'root', 'urn:d', 'child']);
  assert.deepEqual([...child.attrs], [['urn:b|at', '1'], ['|plain', '2']]);
});

// ---- encryption inside compressed parts ----

test('detect: ODF manifest encryption-data and EPUB encryption.xml are seen; font obfuscation is fine', async () => {
  for (const [f, format] of [['refused-encrypted.odt', 'odt'], ['refused-encrypted.ods', 'ods'], ['refused-encrypted.odp', 'odp'], ['refused-drm.epub', 'epub']]) {
    const d = await detect(fxPath(f));
    assert.deepEqual([d.format, d.extractable, d.refusal?.code], [format, false, 'encrypted'], f);
  }
  const ok = await detect(fxPath('text-font-obfuscation.epub'));
  assert.deepEqual([ok.format, ok.extractable], ['epub', true]);
  // The obfuscation algorithm on anything but a font is encryption.
  const enc = (uri, alg = 'http://www.idpf.org/2008/embedding') =>
    zip([
      { name: 'mimetype', data: 'application/epub+zip' },
      { name: 'META-INF/encryption.xml', data: `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="${alg}"/><enc:CipherData><enc:CipherReference URI="${uri}"/></enc:CipherData></enc:EncryptedData></encryption>` },
    ]);
  assert.equal((await detect(enc('OEBPS/text.xhtml'), { name: 'a.epub' })).refusal?.code, 'encrypted');
  assert.equal((await detect(enc('OEBPS/Fonts/a.TTF'), { name: 'a.epub' })).extractable, true);
  assert.equal((await detect(enc('OEBPS/Fonts/a.otf', 'http://ns.adobe.com/pdf/enc#RC'), { name: 'a.epub' })).extractable, true);
  assert.equal((await detect(enc('OEBPS/Fonts/a.otf', 'http://www.w3.org/2001/04/xmlenc#aes128-cbc'), { name: 'a.epub' })).refusal?.code, 'encrypted');
});

test('an encrypted ZIP entry inside a document is refused as encrypted', async () => {
  const odt = zip([{ name: 'mimetype', data: 'application/vnd.oasis.opendocument.text' }, { name: 'content.xml', data: '<x/>', flags: 1 }]);
  await assert.rejects(extract(odt, { name: 'p.odt' }), (e) => e.code === 'encrypted' && e.format === 'odt');
});

// ---- metadata over 1 MB: the worker decides ----

const ODT_CONTENT =
  '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:p>readable</text:p></office:text></office:body></office:document-content>';
const bigManifest = (encrypted) =>
  '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>' +
  '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml">' +
  (encrypted ? '<manifest:encryption-data manifest:checksum-type="SHA1" manifest:checksum="x"/>' : '') +
  '</manifest:file-entry>' +
  '<!--' + ' '.repeat(META_MAX + 10) + '--></manifest:manifest>';

test('ODF: a manifest over 1 MB is unknown to detect; extract checks it in the worker', async () => {
  for (const encrypted of [false, true]) {
    const odt = zip([
      { name: 'mimetype', data: 'application/vnd.oasis.opendocument.text' },
      { name: 'content.xml', data: ODT_CONTENT, deflate: true },
      { name: 'META-INF/manifest.xml', data: bigManifest(encrypted), deflate: true },
    ]);
    const d = await detect(odt, { name: 'm.odt' });
    assert.deepEqual([d.format, d.extractable], ['odt', true], `detect, encrypted=${encrypted}`);
    if (encrypted) await assert.rejects(extract(odt, { name: 'm.odt' }), (e) => e.code === 'encrypted' && e.format === 'odt');
    else assert.deepEqual((await extract(odt, { name: 'm.odt' })).lines, ['readable']);
  }
});

test('EPUB: an encryption.xml over 1 MB is unknown to detect; a spine item listed in it is encrypted in extract', async () => {
  const opf =
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest><item id="c" href="ch.woff" media-type="application/xhtml+xml"/><item id="f" href="f.ttf" media-type="font/ttf"/></manifest><spine><itemref idref="c"/></spine></package>';
  const enc = (uris, pad = '') =>
    '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">' +
    uris.map((u) => `<enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/><enc:CipherData><enc:CipherReference URI="${u}"/></enc:CipherData></enc:EncryptedData>`).join('') +
    `<!--${pad}--></encryption>`;
  const book = (encXml) =>
    zip([
      { name: 'mimetype', data: 'application/epub+zip' },
      { name: 'META-INF/container.xml', data: '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/p.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' },
      { name: 'META-INF/encryption.xml', data: encXml, deflate: true },
      { name: 'OPS/p.opf', data: opf },
      { name: 'OPS/ch.woff', data: '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>T</h1><p>chapter text</p></body></html>' },
      { name: 'OPS/f.ttf', data: 'font' },
    ]);
  // A spine item named like a font, "obfuscated": detect cannot know, the worker refuses.
  const chapter = book(enc(['OPS/ch.woff']));
  assert.equal((await detect(chapter, { name: 'c.epub' })).extractable, true);
  await assert.rejects(extract(chapter, { name: 'c.epub' }), (e) => e.code === 'encrypted' && e.format === 'epub');
  // Only a real font obfuscated: read.
  assert.deepEqual((await extract(book(enc(['OPS/f.ttf'])), { name: 'f.epub' })).lines, ['T', 'chapter text']);
  // Over 1 MB: detect says extractable, the worker reads it under the ZIP caps.
  const big = book(enc(['OPS/f.ttf', 'OPS/other.xhtml'], ' '.repeat(META_MAX + 10)));
  assert.equal((await detect(big, { name: 'b.epub' })).extractable, true);
  await assert.rejects(extract(big, { name: 'b.epub' }), (e) => e.code === 'encrypted');
  assert.deepEqual((await extract(book(enc(['OPS/f.ttf'], ' '.repeat(META_MAX + 10))), { name: 'g.epub' })).lines, ['T', 'chapter text']);
});

// ---- DOCX: inflated here, mammoth gets stored entries ----

test('DOCX: entries are inflated under the ZIP caps before mammoth; a lying declared size never reaches it', async () => {
  const before = converted.count;
  const lying = zip([{ name: 'word/document.xml', data: 'w'.repeat(2_000_000), deflate: true, size: 1000 }]);
  await assert.rejects(extractDocx(lying, { maxDocBytes: 52428800 }), (e) => e instanceof ZipError && e.code === 'damaged' && /larger than its declared 1000 bytes/.test(e.message));
  const honest = zip([{ name: 'word/document.xml', data: 'w'.repeat(2_000_000), deflate: true }]);
  await assert.rejects(extractDocx(honest, { maxDocBytes: 10_000 }), (e) => e instanceof ZipError && e.code === 'too_large');
  assert.equal(converted.count, before, 'mammoth was not called');
  await assert.rejects(extract(lying, { name: 'l.docx' }), (e) => isRefusal('damaged', /^cannot read l\.docx: damaged or unsupported DOCX file$/)(e) && e.format === 'docx');
});

test('storedZip: stored entries with CRC-32 that the own reader reads back', () => {
  const entries = [
    { name: 'a.txt', data: Buffer.from('alpha') },
    { name: 'dir/Ü.xml', data: Buffer.from('<x/>') },
    { name: 'empty', data: Buffer.alloc(0) },
  ];
  const buf = storedZip(entries);
  const z = new Zip(buf);
  assert.deepEqual(z.names, ['a.txt', 'dir/Ü.xml', 'empty']);
  // Buffers compared with equals(): a failing deepEqual on large buffers builds a huge diff.
  for (const e of entries) assert.ok(z.read(e.name).equals(e.data), e.name);
  // CRC-32 (IEEE, reflected 0xEDB88320) computed here bit by bit.
  const crc32 = (b) => {
    let c = 0xffffffff;
    for (const byte of b) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const cd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.equal(buf.readUInt32LE(cd + 16), crc32(Buffer.from('alpha')));
  assert.equal(buf.readUInt32LE(14), crc32(Buffer.from('alpha')));
});
