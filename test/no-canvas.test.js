// doclines never loads @napi-rs/canvas (pdfjs requires it at module load; its
// native binary kills the process on CPUs without AVX). Run with the package present.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { extractInWorker } from '../src/extract.js';
import { guardResolveFilename, isBlocked } from '../src/no-canvas.js';

const ROOT = path.join(import.meta.dirname, '..');
const PDF = path.join(ROOT, 'test', 'fixtures', 'formats', 'text.pdf');
const SPY = pathToFileURL(path.join(ROOT, 'test', 'fixtures', 'spy-extract-worker.mjs'));

test('the specifiers refused: @napi-rs/canvas and its platform packages, nothing else', () => {
  for (const s of ['@napi-rs/canvas', '@napi-rs/canvas/index.js', '@napi-rs/canvas-linux-x64-musl', '@napi-rs/canvas-win32-x64-msvc']) assert.equal(isBlocked(s), true, s);
  for (const s of ['@napi-rs/other', 'canvas', 'pdfjs-dist', '@napi-rs/canvasx']) assert.equal(isBlocked(s), false, s);
});

test('extraction worker: a PDF extracts, the require of @napi-rs/canvas is refused, nothing of it is loaded', async (t) => {
  const present = fs.existsSync(path.join(ROOT, 'node_modules', '@napi-rs', 'canvas'));
  t.diagnostic(`@napi-rs/canvas in node_modules: ${present}`);
  const r = await extractInWorker(fs.readFileSync(PDF), { format: 'pdf', name: 'text.pdf', timeoutMs: 60000, workerUrl: SPY });
  assert.equal(r.format, 'pdf');
  assert.ok(r.lines.some((l) => l.includes('工作温度')), 'CJK text still extracts');
  // The guard refused the require before any other resolver saw it, pdfjs took its
  // own "Cannot load" path, and no @napi-rs file was loaded.
  assert.deepEqual(r.spy.resolved, [], JSON.stringify(r.spy));
  assert.ok(r.spy.printed.some((w) => w.includes('doclines never loads @napi-rs/canvas')), JSON.stringify(r.spy));
  assert.ok(!r.warnings.some((w) => w.includes('@napi-rs')), 'the expected canvas notice is not a warning');
  assert.deepEqual(r.spy.loaded, []);
});

test('pdfjs in the main thread (a test or a tool importing pdf.js) is guarded too; stdout stays clean', () => {
  const pdf = pathToFileURL(path.join(ROOT, 'src', 'pdf.js')).href;
  const guard = pathToFileURL(path.join(ROOT, 'src', 'no-canvas.js')).href;
  const script = `
    import { extractPdf } from ${JSON.stringify(pdf)};
    import { refused } from ${JSON.stringify(guard)};
    import fs from 'node:fs';
    import { createRequire } from 'node:module';
    const r = await extractPdf(fs.readFileSync(${JSON.stringify(PDF)}), 'text.pdf');
    const loaded = Object.keys(createRequire(import.meta.url).cache).filter((k) => k.includes('@napi-rs'));
    process.stderr.write(JSON.stringify({ pages: r.sections.length, refused, loaded }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'pdfjs prints nothing to stdout');
  const out = JSON.parse(r.stderr.slice(r.stderr.lastIndexOf('{"pages"')));
  assert.equal(out.pages, 1);
  assert.ok(out.refused.includes('@napi-rs/canvas'));
  assert.deepEqual(out.loaded, []);
});

test('the fallback for Node without module.registerHooks guards require() resolution', () => {
  const calls = [];
  const Module = { _resolveFilename: (request) => (calls.push(request), `/resolved/${request}`) };
  guardResolveFilename(Module);
  assert.equal(Module._resolveFilename('pdfjs-dist'), '/resolved/pdfjs-dist');
  assert.throws(() => Module._resolveFilename('@napi-rs/canvas'), (e) => e.code === 'MODULE_NOT_FOUND');
  assert.throws(() => Module._resolveFilename('@napi-rs/canvas-linux-x64-gnu'), (e) => e.code === 'MODULE_NOT_FOUND');
  assert.deepEqual(calls, ['pdfjs-dist'], 'the original resolver never sees a canvas specifier');
});
