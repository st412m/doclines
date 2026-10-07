// cheap-eyes 0.2 compatibility: for every fixture cheap-eyes 0.2 reads and doclines
// extracts as text, html, pdf, docx, doc or rtf, the output is identical byte for byte.
// test/golden/*.json are written by tools/make-golden.mjs from the cheap-eyes 0.2 code.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { extract } from '../src/index.js';
import { COMPARED, difference, viewOfCheapEyes, viewOfDoclines } from '../tools/golden-lib.mjs';
import { FX, ROOT } from './helpers.js';

const GOLDEN = path.join(ROOT, 'test', 'golden');
const goldens = fs
  .readdirSync(GOLDEN)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(GOLDEN, f), 'utf8')));

test('a golden file for every fixture (re-run tools/make-golden.mjs after adding one)', () => {
  const fixtures = fs.readdirSync(FX).filter((f) => f !== 'fixtures.json').sort();
  assert.deepEqual(goldens.map((g) => g.file), fixtures);
});

for (const g of goldens.filter((x) => x.outcome === 'text')) {
  test(`golden ${g.file}: identical to cheap-eyes ${g.cheapEyes}`, async (t) => {
    let r;
    try {
      r = await extract(path.join(FX, g.file));
    } catch (e) {
      if (e.name === 'DoclinesError' && e.format && !COMPARED.has(e.format)) return t.skip(`doclines format ${e.format} (refused), not compared`);
      throw e;
    }
    if (!COMPARED.has(r.format)) return t.skip(`doclines format ${r.format}, not compared`);
    const diff = difference(viewOfCheapEyes(g), viewOfDoclines(r));
    assert.equal(diff, null, `${g.file}: ${diff}`);
  });
}

test('refused by cheap-eyes 0.2: listed, not compared', (t) => {
  const refused = goldens.filter((g) => g.outcome === 'refused');
  for (const g of refused) t.diagnostic(`${g.file}: ${g.reason ?? g.message}`);
  assert.ok(refused.every((g) => typeof g.message === 'string'));
});
