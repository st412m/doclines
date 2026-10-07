// A word broken by a soft hyphen at a PDF line end. The shape of the real case: the
// soft hyphen is drawn as its own text run at the line end and mapped to U+00AD by the
// font's ToUnicode; pdfjs drops Cf glyphs from its text content unless the
// keep-soft-hyphen hook keeps it. The PDF is built here, not committed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { extract, extractInWorker } from '../src/extract.js';
import { patchWorkerSource, softHyphenWarning } from '../src/keep-soft-hyphen.js';
import { tmpDir } from './helpers.js';

// A one-page PDF: Helvetica with a ToUnicode CMap (printable ASCII as is, 0xAD → U+00AD).
// `lines`: per line, the text runs drawn with Tj (latin1; "\xad" is the soft hyphen).
function makePdf(lines) {
  const esc = (s) => [...s].map((c) => (c === '\xad' ? '\\255' : c.replace(/[()\\]/g, '\\$&'))).join('');
  const content = ['BT', '/F1 12 Tf', '72 720 Td', ...lines.flatMap((runs, i) => [...(i ? ['0 -16 Td'] : []), ...runs.map((r) => `(${esc(r)}) Tj`)]), 'ET'].join('\n');
  const cmap = [
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def /CMapType 2 def',
    '1 begincodespacerange <00> <FF> endcodespacerange',
    '1 beginbfrange <20> <7E> <0020> endbfrange',
    '1 beginbfchar <AD> <00AD> endbfchar',
    'endcmap CMapName currentdict /CMap defineresource pop end end',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 6 0 R >>',
    `<< /Length ${Buffer.byteLength(cmap, 'latin1')} >>\nstream\n${cmap}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('a soft hyphen drawn at a PDF line end joins the word; a hard hyphen stays; a mid-line one is dropped', async () => {
  const d = tmpDir();
  const file = path.join(d, 'soft.pdf');
  fs.writeFileSync(
    file,
    makePdf([
      ['We plani', '\xad'],
      ['ruem to simplify the access for companies'],
      ['north-'],
      ['west of the region and further on'],
      ['in the mid\xaddle of a line, nothing else'],
    ]),
  );
  const r = await extract(file);
  assert.deepEqual(r.lines, ['We planiruem', 'to simplify the access for companies', 'north-', 'west of the region and further on', 'in the middle of a line, nothing else']);
});

test('the hook keeps only U+00AD of the Cf glyphs pdfjs drops, and the installed pdfjs has that code', () => {
  const src = 'x;\n        if (category.isInvisibleFormatMark) {\n          continue;\n        }\n';
  assert.equal(patchWorkerSource(src), 'x;\n        if (category.isInvisibleFormatMark && glyph.unicode !== "\\u00ad") {\n          continue;\n        }\n');
  assert.equal(patchWorkerSource('other code'), 'other code', 'unknown code stays as it is');
  // The pdfjs version installed has exactly one place to patch.
  const worker = fs.readFileSync(path.join(import.meta.dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.mjs'), 'utf8');
  assert.equal(worker.split('if (category.isInvisibleFormatMark) {').length - 1, 1);
});

// ---- the warning when the patch is missing ----

test('warning text: when pdfjs code was seen but not patched, or hooks are missing; never otherwise', () => {
  const msg = /^pdfjs 6\.3\.289 not patched for soft hyphens; words broken at line ends stay split$/;
  assert.match(softHyphenWarning({ hooks: true, seen: true, patched: false }), msg);
  assert.match(softHyphenWarning({ hooks: false, seen: false, patched: false }), msg);
  assert.equal(softHyphenWarning({ hooks: true, seen: true, patched: true }), null);
  assert.equal(softHyphenWarning({ hooks: true, seen: false, patched: false }), null);
});

test('a pdfjs source without the expected line: extraction still works, the warning comes with it', () => {
  const pdf = pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'pdf.js')).href;
  // Registered first, so it runs after doclines' hook in the chain and hands it a
  // worker source without the line to patch.
  const script = `
    import module from 'node:module';
    module.registerHooks({ load(url, context, nextLoad) {
      const r = nextLoad(url, context);
      if (!/pdf\.worker\.mjs$/.test(url)) return r;
      const s = typeof r.source === 'string' ? r.source : Buffer.from(r.source).toString('utf8');
      return { ...r, source: s.replace('if (category.isInvisibleFormatMark) {', 'if (category.isInvisibleFormatMark /* changed */) {') };
    } });
    const { extractPdf } = await import(${JSON.stringify(pdf)});
    const fs = await import('node:fs');
    const r = await extractPdf(fs.readFileSync(${JSON.stringify(path.join(import.meta.dirname, 'fixtures', 'formats', 'text.pdf'))}), 'text.pdf');
    process.stdout.write(JSON.stringify({ pages: r.sections.length, warning: r.warning }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.pages, 1);
  assert.match(out.warning, /^pdfjs 6\.3\.289 not patched for soft hyphens; words broken at line ends stay split$/);
});

test('the patched pdfjs gives no warning; a worker warning comes back in result.warnings, never printed', async () => {
  const d = tmpDir();
  const r = await extractInWorker(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'formats', 'text.pdf')), { format: 'pdf', name: 'text.pdf', timeoutMs: 60000 });
  assert.ok(r.lines.length > 5);
  assert.deepEqual(r.warnings.filter((w) => !w.startsWith('heap cap of ')), [], 'the installed pdfjs is patched');
  const ext = pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'extract.js')).href;
  const fake = pathToFileURL(path.join(import.meta.dirname, 'fixtures', 'fake-extract-worker.mjs')).href;
  const script = `
    import { extractInWorker } from ${JSON.stringify(ext)};
    const r = await extractInWorker(Buffer.from('x'), { format: 'captured', name: 'w', timeoutMs: 5000, workerUrl: new URL(${JSON.stringify(fake)}) });
    process.stdout.write(JSON.stringify(r.warnings));`;
  const p = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', cwd: d });
  assert.equal(p.status, 0, p.stderr);
  assert.deepEqual(JSON.parse(p.stdout), ['Warning: TT: undefined function: 32'], 'printed once, the canvas notice dropped');
  assert.equal(p.stderr, '');
});
