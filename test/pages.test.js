// Markers, page tables and sections: assemble, pageOf/pageRanges, sectionOf, and the
// CLI rendering of markers before their line.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { extract, foldSpace, pageOf, pageRanges, sectionOf, version } from '../src/index.js';
import { assemble } from '../src/normalize.js';
import { CLI, fxPath } from './helpers.js';

test('assemble: marker lines are not numbered; page table maps lines to pages; sections with ranges', () => {
  const r = assemble([
    { marker: '--- page 1 ---', page: 1, kind: 'page', n: 1, text: 'a\nb' },
    { marker: '--- page 2 ---', page: 2, kind: 'page', n: 2, text: '' },
    { marker: '--- page 3 ---', page: 3, kind: 'page', n: 3, text: 'c' },
  ]);
  assert.deepEqual(r.lines, ['a', 'b', 'c']);
  assert.deepEqual(r.markers, [
    { at: 0, text: '--- page 1 ---' },
    { at: 2, text: '--- page 2 ---' },
    { at: 2, text: '--- page 3 ---' },
  ]);
  assert.deepEqual(r.pageStarts, [1, 3, 3]);
  // An empty section has end = start - 1.
  assert.deepEqual(r.sections, [
    { kind: 'page', n: 1, label: null, start: 1, end: 2 },
    { kind: 'page', n: 2, label: null, start: 3, end: 2 },
    { kind: 'page', n: 3, label: null, start: 3, end: 3 },
  ]);
  assert.deepEqual([1, 2, 3].map((n) => pageOf(r.pageStarts, n)), [1, 1, 3]);
  assert.deepEqual([1, 2, 3, 4].map((n) => sectionOf(r, n)?.n ?? null), [1, 1, 3, null]);
  assert.equal(pageOf(null, 1), null);
  assert.equal(pageRanges([3, 7, 8, 9, 12]), '3, 7–9, 12');
  assert.equal(foldSpace(' a\u00a0\u00ad b \n c '), 'a b c');
});

test('assemble: an unmarked body section is not listed; maxTextBytes stops at the first line over it', () => {
  const r = assemble([{ marker: null, text: 'body' }, { marker: '--- footnotes ---', kind: 'footnotes', text: 'note' }]);
  assert.deepEqual(r.sections, [{ kind: 'footnotes', n: null, label: null, start: 2, end: 2 }]);
  let produced = 0;
  const big = { marker: null, text: Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n') };
  assert.throws(
    () => assemble([big], { maxTextBytes: 20, tooLarge: () => new Error(`stopped after ${(produced = 1)}`) }),
    /stopped/,
  );
  assert.equal(produced, 1);
});

test('sectionOf: the innermost section holding the line', () => {
  const r = {
    sections: [
      { kind: 'attachment', n: null, label: 'a.pdf', start: 5, end: 20 },
      { kind: 'page', n: 1, label: null, start: 5, end: 9 },
      { kind: 'page', n: 2, label: null, start: 10, end: 20 },
    ],
  };
  assert.equal(sectionOf(r, 4), null);
  assert.equal(sectionOf(r, 5).kind, 'page');
  assert.equal(sectionOf(r, 12).n, 2);
  assert.equal(sectionOf({ sections: [] }, 1), null);
});

test('RTF and DOC footnotes: a trailing section after its marker', async () => {
  const rtf = Buffer.from('{\\rtf1\\ansi Body{\\super\\chftn}{\\footnote\\pard\\plain\\chftn Note text.}\\par After\\par}', 'latin1');
  const r = await extract(rtf, { name: 'n.rtf' });
  assert.deepEqual(r.lines, ['Body', 'After', 'Note text.']);
  assert.deepEqual(r.markers, [{ at: 2, text: '--- footnotes ---' }]);
  assert.deepEqual(r.sections, [{ kind: 'footnotes', n: null, label: null, start: 3, end: 3 }]);
  assert.equal(sectionOf(r, 3).kind, 'footnotes');
  assert.equal(sectionOf(r, 1), null);
  const doc = await extract(fxPath('text.doc'));
  assert.deepEqual([doc.markers, doc.sections, doc.pageStarts], [[], [], null]);
});

test('CLI: numbered lines with the page marker before its line; JSON; detect; exit codes', () => {
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  const r = run(fxPath('text.pdf'));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.split('\n').slice(0, 2), ['--- page 1 ---', 'L1| Fixture: cheap-eyes formats']);
  assert.equal(r.stderr, '');
  const j = run(fxPath('text.docx'), '--json');
  assert.equal(JSON.parse(j.stdout).format, 'docx');
  const d = run(fxPath('text.doc'), '--detect');
  assert.deepEqual([d.status, JSON.parse(d.stdout).format], [0, 'doc']);
  const no = run(fxPath('text.docx'), '--formats', 'pdf,rtf');
  assert.deepEqual([no.status, no.stdout, no.stderr], [2, '', 'format not allowed: Word document (.docx) (text.docx)\n']);
  const big = run(fxPath('text.pdf'), '--max-text-bytes', '100');
  assert.equal(big.status, 2);
  assert.match(big.stderr, /^extracted text too large: text\.pdf/);
  assert.equal(run(fxPath('text.pdf'), '--timeout', '0.001').status, 2);
  assert.equal(run().status, 1);
  assert.equal(run('--version').stdout.trim(), version);
});
