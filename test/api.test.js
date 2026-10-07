// The public API: exports, FORMATS, DoclinesError and its codes, options, the result,
// detect, silence on stdout/stderr, CommonJS consumers.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import * as doclines from '../src/index.js';
import { CODES } from '../src/errors.js';
import { extractInWorker } from '../src/extract.js';
import { heapCapWarning } from '../src/heap.js';
import { FAKE_WORKER, FX, fx, fxPath, isRefusal, ROOT, srcUrl, tmpDir, zip } from './helpers.js';

const { DoclinesError, detect, extract, FORMATS, version } = doclines;
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('exports: exactly the documented names', () => {
  assert.deepEqual(Object.keys(doclines).sort(), [
    'DoclinesError',
    'FORMATS',
    'detect',
    'extract',
    'foldSpace',
    'normalizeText',
    'pageOf',
    'pageRanges',
    'sectionOf',
    'version',
  ]);
  assert.equal(version, PKG.version);
});

test('FORMATS: frozen, every format id, each with label, family, extensions, textOnDisk', () => {
  assert.ok(Object.isFrozen(FORMATS));
  assert.deepEqual(
    FORMATS.map((f) => f.id),
    ['text', 'html', 'pdf', 'docx', 'doc', 'rtf', 'xlsx', 'xls', 'ods', 'pptx', 'ppt', 'odt', 'odp', 'epub', 'fb2', 'eml', 'msg'],
  );
  for (const f of FORMATS) {
    assert.ok(Object.isFrozen(f) && Object.isFrozen(f.extensions), f.id);
    assert.deepEqual(Object.keys(f), ['id', 'label', 'family', 'extensions', 'textOnDisk']);
    assert.ok(f.label && f.family && f.extensions.length && f.extensions.every((e) => e.startsWith('.')), f.id);
  }
  assert.deepEqual(FORMATS.filter((f) => f.textOnDisk).map((f) => f.id), ['text', 'html', 'rtf', 'fb2', 'eml']);
  // Labels cheap-eyes 0.2 already shows to people stay word for word.
  const label = (id) => FORMATS.find((f) => f.id === id).label;
  assert.equal(label('xls'), 'Excel workbook (.xls)');
  assert.equal(label('xlsx'), 'Excel workbook (.xlsx)');
  assert.equal(label('pptx'), 'PowerPoint presentation (.pptx)');
  assert.equal(label('ppt'), 'PowerPoint presentation (.ppt)');
  assert.equal(label('odt'), 'OpenDocument text (.odt)');
  assert.equal(label('epub'), 'EPUB book (.epub)');
});

test('DoclinesError: name, code, format, label, reason, message; the code list', () => {
  assert.deepEqual(CODES, ['unsupported', 'not_allowed', 'encrypted', 'no_text_layer', 'damaged', 'too_large', 'text_too_large', 'timeout', 'out_of_memory', 'binary', 'not_a_file']);
  const e = new DoclinesError('encrypted', 'm', { format: 'pdf', label: 'L', reason: 'r' });
  assert.ok(e instanceof Error);
  assert.deepEqual([e.name, e.code, e.format, e.label, e.reason, e.message, 'detail' in e], ['DoclinesError', 'encrypted', 'pdf', 'L', 'r', 'm', false]);
  assert.deepEqual(new DoclinesError('binary', 'x').toJSON(), { code: 'binary', message: 'x', format: null, label: null, reason: null });
});

test('result: every field, numbered lines without newlines, hash and size of the input', async () => {
  const r = await extract(fxPath('text.pdf'));
  assert.deepEqual(Object.keys(r), ['format', 'label', 'charset', 'lines', 'markers', 'sections', 'pageStarts', 'pagesWithoutText', 'warnings', 'bytes', 'sha256', 'doclinesVersion']);
  assert.equal(r.format, 'pdf');
  assert.equal(r.label, 'PDF document (.pdf)');
  assert.equal(r.charset, null);
  assert.ok(r.lines.every((l) => typeof l === 'string' && !l.includes('\n')));
  assert.deepEqual(r.sections, [{ kind: 'page', n: 1, label: null, start: 1, end: r.lines.length }]);
  // The heap-cap warning appears when the host runs with --max-old-space-size.
  assert.deepEqual(r.warnings.filter((w) => !w.startsWith('heap cap of ')), []);
  const buf = fx('text.pdf');
  assert.equal(r.bytes, buf.length);
  assert.equal(r.sha256, (await import('node:crypto')).createHash('sha256').update(buf).digest('hex'));
  assert.equal(r.doclinesVersion, PKG.version);
  const t = await extract(fxPath('book.md'));
  assert.deepEqual([t.format, t.label, t.charset, t.markers, t.sections, t.pageStarts, t.pagesWithoutText], ['text', 'plain text', 'utf-8', [], [], null, []]);
});

test('input: a path, a Buffer or a Uint8Array give the same result; name defaults to the basename or "input"', async () => {
  const a = await extract(fxPath('text.docx'));
  const buf = fx('text.docx');
  const b = await extract(buf);
  const u = await extract(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
  assert.deepEqual(b.lines, a.lines);
  assert.deepEqual(u.lines, a.lines);
  assert.equal(buf.length, fs.statSync(fxPath('text.docx')).size, 'the caller\'s buffer is not detached');
  await assert.rejects(extract(Buffer.from([0x41, 0, 0x42])), isRefusal('binary', /^binary file refused: input$/));
  await assert.rejects(extract(fxPath('refused-image.png')), isRefusal('unsupported', /^unsupported format: image \(PNG\), no OCR \(refused-image\.png\)$/));
  await assert.rejects(extract(Buffer.from([0x41, 0, 0x42]), { name: 'x.bin' }), isRefusal('binary', /x\.bin/));
  await assert.rejects(() => extract(42), TypeError);
});

test('contentType: HTML by type, charset for text and HTML', async () => {
  const html = await extract(Buffer.from('<p>Hello</p><p>world</p>'), { contentType: 'text/html; charset=utf-8' });
  assert.deepEqual([html.format, html.lines], ['html', ['Hello', 'world']]);
  assert.equal((await extract(Buffer.from('<p>Hello</p>'))).format, 'text');
  const cp = Buffer.from([0xc4, 0xe0, 0x0a]); // "Да\n" in windows-1251
  const t = await extract(cp, { contentType: 'text/plain; charset=windows-1251' });
  assert.deepEqual([t.format, t.charset, t.lines], ['text', 'windows-1251', ['Да']]);
  // A BOM beats the declared charset.
  const bom = await extract(Buffer.from('\ufeffДа\n'), { contentType: 'text/plain; charset=windows-1251' });
  assert.deepEqual([bom.charset, bom.lines], ['utf-8', ['Да']]);
});

test('refusal codes: not_allowed, encrypted, no_text_layer, damaged, unsupported, not_a_file', async () => {
  await assert.rejects(extract(fxPath('text.docx'), { formats: ['pdf'] }), (e) => isRefusal('not_allowed', /^format not allowed: Word document \(\.docx\) \(text\.docx\)$/)(e) && e.format === 'docx');
  await assert.rejects(extract(fxPath('book.md'), { text: 'never' }), isRefusal('not_allowed', /plain text/));
  await assert.rejects(extract(fxPath('book.md'), { formats: ['pdf', 'docx'] }), isRefusal('not_allowed'));
  assert.equal((await extract(fxPath('book.md'), { formats: ['text'] })).format, 'text');
  await assert.rejects(extract(fxPath('refused-encrypted.pdf')), (e) => isRefusal('encrypted', /^encrypted document: password-protected files are not read \(refused-encrypted\.pdf\)$/)(e) && e.reason === 'encrypted document');
  await assert.rejects(extract(fxPath('refused-encrypted.doc')), (e) => e.code === 'encrypted' && e.format === 'doc' && e.label === 'Word document (.doc)');
  await assert.rejects(extract(fxPath('refused-scan.pdf')), (e) => isRefusal('no_text_layer')(e) && e.reason === 'no usable text layer (scanned PDF?)');
  await assert.rejects(extract(Buffer.from('%PDF-1.4\nnot really a pdf\n%%EOF\n')), (e) => isRefusal('damaged')(e) && e.format === 'pdf');
  await assert.rejects(extract(fxPath('refused-archive.zip')), (e) => isRefusal('unsupported', /^unsupported format: ZIP archive \(refused-archive\.zip\)$/)(e) && e.format === null);
  const d = tmpDir();
  await assert.rejects(extract(d), isRefusal('not_a_file', /^not a regular file: /));
  await assert.rejects(extract(path.join(d, 'missing.txt')), isRefusal('not_a_file', /^no such file: missing\.txt$/));
});

test('damaged: the internal error is in `detail`, never in the message', async () => {
  // A ZIP with the DOCX main part only, holding no valid XML: mammoth throws.
  const broken = zip([{ name: 'word/document.xml', data: '<w:document><<<' }]);
  await assert.rejects(extract(broken, { name: 'broken.docx' }), (e) => {
    if (e.code !== 'damaged') return false;
    assert.equal(e.message, 'cannot read broken.docx: damaged or unsupported DOCX file');
    assert.equal(e.reason, 'damaged or unsupported file');
    assert.equal(e.format, 'docx');
    assert.equal(typeof e.detail, 'string');
    return true;
  });
});

test('options: unknown values are a TypeError, not a refusal', async () => {
  await assert.rejects(() => extract(fxPath('book.md'), { formats: ['nope'] }), TypeError);
  await assert.rejects(() => extract(fxPath('book.md'), { formats: 'pdf' }), TypeError);
  await assert.rejects(() => extract(fxPath('book.md'), { text: 'always' }), TypeError);
  await assert.rejects(() => extract(fxPath('book.md'), { maxTextBytes: 0 }), TypeError);
  await assert.rejects(() => extract(fxPath('book.md'), { attachments: { depth: 2 } }), TypeError);
});

test('maxTextBytes: refused while the lines are produced, never truncated', async () => {
  const full = await extract(fxPath('text.pdf'));
  const bytes = full.lines.reduce((s, l) => s + Buffer.byteLength(l) + 1, 0);
  assert.equal((await extract(fxPath('text.pdf'), { maxTextBytes: bytes })).lines.length, full.lines.length);
  await assert.rejects(extract(fxPath('text.pdf'), { maxTextBytes: bytes - 1 }), (e) => isRefusal('text_too_large', /^extracted text too large: text\.pdf \(over \d+ bytes\)$/)(e) && e.format === 'pdf');
});

test('timeout: the worker is ended, the call refused', async () => {
  const t0 = Date.now();
  await assert.rejects(
    extractInWorker(Buffer.from('x'), { format: 'hang', name: 'evil.pdf', timeoutMs: 300, workerUrl: FAKE_WORKER }),
    (e) => isRefusal('timeout', /^extraction timed out after 0\.3 s: evil\.pdf$/)(e) && e.reason === 'extraction timed out',
  );
  assert.ok(Date.now() - t0 < 5000);
  await assert.rejects(extract(fxPath('text.pdf'), { timeoutMs: 1 }), isRefusal('timeout'));
});

test('heap cap: a worker over heapMb is ended, the call refused', async (t) => {
  let answer;
  await assert.rejects(
    extractInWorker(Buffer.from('x'), { format: 'oom', name: 'bomb.docx', timeoutMs: 60000, heapMb: 32, workerUrl: FAKE_WORKER }).then((r) => {
      answer = r;
      throw new Error('answered');
    }),
    (e) => (answer ? true : isRefusal('out_of_memory', /^extraction ran out of memory \(32 MB\): bomb\.docx$/)(e) && e.reason === 'extraction ran out of memory'),
  );
  // The host runs with --max-old-space-size: the cap is not in effect, the fake worker
  // answered with the reason instead of filling the heap.
  if (answer) t.skip(answer.warnings[0]);
});

// NODE_OPTIONS of this process without --max-old-space-size (a CI or sandbox may set it).
function envWithoutHeapFlag() {
  const env = { ...process.env };
  const rest = (env.NODE_OPTIONS ?? '').split(/\s+/).filter((o) => o && !/^--max-old-space-size(?:=|$)/.test(o) && !/^--max_old_space_size(?:=|$)/.test(o));
  if (rest.length) env.NODE_OPTIONS = rest.join(' ');
  else delete env.NODE_OPTIONS;
  return env;
}

// heapCapWarning inside workers started with each heapMb, in a child process run with
// `flags` and `env` (this process's own --max-old-space-size removed from NODE_OPTIONS).
function warningsByHeapMb(mbs, { flags = [], nodeOptions = null } = {}) {
  const script = `
    import { Worker } from 'node:worker_threads';
    const out = {};
    for (const mb of ${JSON.stringify(mbs)}) {
      out[mb] = await new Promise((resolve, reject) => {
        const code = 'import(' + JSON.stringify(${JSON.stringify(srcUrl('heap.js'))}) + ').then((h) => process.getBuiltinModule("node:worker_threads").parentPort.postMessage(h.heapCapWarning(' + mb + ')))';
        const w = new Worker(code, { eval: true, resourceLimits: { maxOldGenerationSizeMb: mb } });
        w.once('message', (m) => { resolve(m); w.terminate(); });
        w.once('error', reject);
      });
    }
    process.stdout.write(JSON.stringify(out));`;
  const env = envWithoutHeapFlag();
  if (nodeOptions) env.NODE_OPTIONS = [env.NODE_OPTIONS, nodeOptions].filter(Boolean).join(' ');
  const r = spawnSync(process.execPath, [...flags, '--input-type=module', '-e', script], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('heap cap in effect: no warning for any heapMb from 16 to 4096 on a host without --max-old-space-size', () => {
  const mbs = [16, 32, 64, 128, 256, 512, 1024, 2048, 4096];
  assert.deepEqual(warningsByHeapMb(mbs), Object.fromEntries(mbs.map((mb) => [mb, null])));
});

test('heap cap not in effect: --max-old-space-size=4096 or NODE_OPTIONS=--max-old-space-size=8192 give the warning at heapMb 32 and 1024', () => {
  const re = (mb) => new RegExp(`^heap cap of ${mb} MB not in effect: the host process sets --max-old-space-size \\(worker heap limit (\\d+) MB\\)$`);
  for (const [opts, min] of [[{ flags: ['--max-old-space-size=4096'] }, 4096], [{ nodeOptions: '--max-old-space-size=8192' }, 8192]]) {
    const w = warningsByHeapMb([32, 1024], opts);
    for (const mb of [32, 1024]) {
      const m = re(mb).exec(w[mb]);
      assert.ok(m && Number(m[1]) >= min, `${JSON.stringify(opts)} heapMb ${mb}: ${w[mb]}`);
    }
  }
});

test('heap cap not in effect: the warning comes back in result.warnings of extract', () => {
  const script = `
    import { extract } from ${JSON.stringify(srcUrl('index.js'))};
    const r = await extract(${JSON.stringify(fxPath('text.pdf'))}, { heapMb: 32 });
    process.stdout.write(JSON.stringify(r.warnings));`;
  const run = (flags) => spawnSync(process.execPath, [...flags, '--input-type=module', '-e', script], { encoding: 'utf8', env: envWithoutHeapFlag() });
  const flagged = run(['--max-old-space-size=4096']);
  assert.equal(flagged.status, 0, flagged.stderr);
  assert.deepEqual(JSON.parse(flagged.stdout).filter((w) => w.startsWith('heap cap of 32 MB not in effect')).length, 1);
  const plain = run([]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.deepEqual(JSON.parse(plain.stdout), []);
});

test('heapCapWarning: not in effect when the limit exceeds heapMb + 512 MB', () => {
  assert.equal(heapCapWarning(32, 80), null); // Node 22, no flags
  assert.equal(heapCapWarning(32, 224), null); // Node 24, no flags
  assert.equal(heapCapWarning(32, 544), null);
  assert.match(heapCapWarning(32, 545), /^heap cap of 32 MB not in effect: .*\(worker heap limit 545 MB\)$/);
  assert.equal(heapCapWarning(1024, 1216), null);
  assert.equal(heapCapWarning(1024, 1536), null);
  assert.ok(heapCapWarning(1024, 1537));
  assert.equal(heapCapWarning(4096, 4288), null);
  assert.ok(heapCapWarning(1024, 4144));
  assert.ok(heapCapWarning(1024, 8384));
  // A host limit below heapMb is a stricter cap, not a missing one.
  assert.equal(heapCapWarning(1024, 112), null);
});

test('internal extractor errors never reach the caller verbatim; a crashed worker is a refusal', async () => {
  await assert.rejects(extractInWorker(Buffer.from('x'), { format: 'internal', name: 'a.doc', timeoutMs: 5000, workerUrl: FAKE_WORKER }), (e) => {
    assert.equal(e.code, 'damaged');
    assert.equal(e.message, 'cannot read a.doc: damaged or unsupported internal file');
    assert.equal(e.detail, 'Attempt to access memory outside buffer bounds');
    return true;
  });
  await assert.rejects(extractInWorker(Buffer.from('x'), { format: 'crash', name: 'b.pdf', timeoutMs: 5000, workerUrl: FAKE_WORKER }), isRefusal('damaged', /^cannot read b\.pdf: damaged or unsupported/));
});

test('detect: format, label, family, textOnDisk, extractable, refusal; no extractor runs', async () => {
  assert.deepEqual(await detect(fxPath('text.docx')), { format: 'docx', label: 'Word document (.docx)', family: 'document', textOnDisk: false, extractable: true, refusal: null });
  assert.deepEqual(await detect(fxPath('lo-export.rtf')), { format: 'rtf', label: 'RTF document (.rtf)', family: 'document', textOnDisk: true, extractable: true, refusal: null });
  assert.deepEqual(await detect(fxPath('book.md')), { format: 'text', label: 'plain text', family: 'text', textOnDisk: true, extractable: true, refusal: null });
  const enc = await detect(fxPath('refused-encrypted.docx'));
  assert.deepEqual([enc.format, enc.extractable, enc.refusal.code], ['docx', false, 'encrypted']);
  const png = await detect(fxPath('refused-image.png'));
  assert.deepEqual([png.format, png.label, png.extractable, png.refusal.code], [null, 'image (PNG), no OCR', false, 'unsupported']);
  const bin = await detect(Buffer.from([0x41, 0, 0x42]));
  assert.deepEqual([bin.format, bin.refusal.code], [null, 'binary']);
  const big = await detect(fxPath('text.doc'), { maxDocBytes: 100 });
  assert.deepEqual([big.format, big.refusal.code], [null, 'too_large']);
  assert.equal((await detect(fx('utf8.html').subarray(0, 200), { name: 'x.html' })).format, 'html');
  assert.equal((await detect(Buffer.from('<p>x</p>'), { contentType: 'application/xhtml+xml' })).format, 'html');
  assert.equal((await detect(tmpDir())).refusal.code, 'not_a_file');
  // formats and text apply as in extract.
  const no = await detect(fxPath('text.docx'), { formats: ['pdf'] });
  assert.deepEqual(no, {
    format: 'docx',
    label: 'Word document (.docx)',
    family: 'document',
    textOnDisk: false,
    extractable: false,
    refusal: { code: 'not_allowed', message: 'format not allowed: Word document (.docx) (text.docx)' },
  });
  const never = await detect(fxPath('book.md'), { text: 'never' });
  assert.deepEqual([never.format, never.extractable, never.refusal.code], ['text', false, 'not_allowed']);
  assert.deepEqual([(await detect(fxPath('text.pdf'), { formats: ['docx'] })).refusal.code, (await detect(fxPath('text.pdf'), { formats: ['pdf'] })).extractable], ['not_allowed', true]);
  // A scanned PDF is found out only by extraction.
  assert.equal((await detect(fxPath('refused-scan.pdf'))).extractable, true);
});

test('nothing reaches stdout or stderr: extraction, refusals and a noisy worker (spawned child)', () => {
  const script = `
    import { extract, detect } from ${JSON.stringify(srcUrl('index.js'))};
    import { extractInWorker } from ${JSON.stringify(srcUrl('extract.js'))};
    const r = await extractInWorker(Buffer.from('x'), { format: 'noisy', name: 'n', timeoutMs: 5000, workerUrl: new URL(${JSON.stringify(FAKE_WORKER.href)}) });
    if (r.lines[0] !== 'ok') process.exit(2);
    for (const f of ['text.pdf', 'text.docx', 'text.doc', 'lo-export.rtf', 'utf8.html', 'book.md', 'text.xlsx', 'text.ods', 'text.pptx', 'text.odp', 'text.odt', 'text.epub', 'text.fb2']) {
      const x = await extract(${JSON.stringify(FX + path.sep)} + f);
      if (x.lines.length < 5) process.exit(3);
      await detect(${JSON.stringify(FX + path.sep)} + f);
    }
    for (const f of ['refused-scan.pdf', 'refused-encrypted.pdf', 'refused-encrypted.doc', 'refused-drm.epub', 'refused-damaged.docx', 'refused-image.png']) {
      try { await extract(${JSON.stringify(FX + path.sep)} + f); process.exit(4); } catch (e) { if (e.name !== 'DoclinesError') process.exit(5); }
    }
    try { await extract(Buffer.from('%PDF-1.4 broken')); process.exit(6); } catch (e) { if (e.code !== 'damaged') process.exit(7); }`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('CommonJS consumer: await import() and require() of the package', () => {
  const d = tmpDir();
  fs.mkdirSync(path.join(d, 'node_modules'));
  fs.symlinkSync(ROOT, path.join(d, 'node_modules', 'doclines'), 'junction');
  const script = path.join(d, 'consumer.cjs');
  fs.writeFileSync(
    script,
    `'use strict';
(async () => {
  const d = await import('doclines');
  const r = await d.extract(process.argv[2]);
  const viaRequire = require('doclines');
  process.stdout.write(JSON.stringify({ format: r.format, first: r.lines[0], version: d.version, same: viaRequire.extract === d.extract }));
})();
`,
  );
  const r = spawnSync(process.execPath, [script, fxPath('text.docx')], { encoding: 'utf8', cwd: d });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { format: 'docx', first: 'Fixture: cheap-eyes formats', version: PKG.version, same: true });
});

test('package.json: ESM, engines, bin, files, exact pins', () => {
  assert.equal(PKG.type, 'module');
  assert.equal(PKG.engines.node, '>=22.17');
  assert.deepEqual(PKG.bin, { doclines: 'src/cli.js' });
  assert.deepEqual(PKG.files, ['src/', 'README.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE']);
  assert.equal(PKG.dependencies['pdfjs-dist'], '6.3.289');
  assert.equal(PKG.dependencies['word-extractor'], '1.0.4');
  assert.equal(PKG.license, 'MIT');
  assert.equal(PKG.author, 'st412m');
});

test('no module of the package uses top-level await (require(esm) works)', () => {
  for (const f of fs.readdirSync(path.join(ROOT, 'src'))) {
    // Top-level statements start in column 0; code inside functions is indented.
    const top = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8').split('\n').filter((l) => /^[^\s/]/.test(l));
    assert.deepEqual(top.filter((l) => /\bawait\b/.test(l)), [], f);
  }
});
