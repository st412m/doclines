#!/usr/bin/env node
// Writes test/golden/<fixture>.json: the cheap-eyes 0.2 result for every file in
// test/fixtures/formats/, produced by the cheap-eyes 0.2 code in <cheap-eyes-dir>
// (read only). test/golden.test.js compares doclines with these files.
//
//   node tools/make-golden.mjs <cheap-eyes-dir>
import fs from 'node:fs';
import path from 'node:path';
import { loadCheapEyes } from './golden-lib.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const FX = path.join(ROOT, 'test', 'fixtures', 'formats');
const OUT = path.join(ROOT, 'test', 'golden');

const dir = process.argv[2];
if (!dir) {
  process.stderr.write('usage: node tools/make-golden.mjs <cheap-eyes-dir>\n');
  process.exit(1);
}
const ce = await loadCheapEyes(path.resolve(dir));
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (f.endsWith('.json')) fs.rmSync(path.join(OUT, f));

const files = fs.readdirSync(FX).filter((f) => f !== 'fixtures.json' && fs.statSync(path.join(FX, f)).isFile()).sort();
let read = 0;
for (const file of files) {
  let golden;
  try {
    const r = await ce.readSource(path.join(FX, file));
    golden = {
      file,
      cheapEyes: ce.version,
      outcome: 'text',
      format: r.format,
      encoding: r.encoding ?? null,
      lines: r.lines,
      markers: r.markers,
      pageStarts: r.pageStarts,
      pagesWithoutText: r.pagesWithoutText,
    };
    read++;
  } catch (e) {
    if (e?.name !== 'InputError') throw e;
    golden = { file, cheapEyes: ce.version, outcome: 'refused', message: e.message, reason: e.reason ?? null };
  }
  fs.writeFileSync(path.join(OUT, `${file}.json`), `${JSON.stringify(golden, null, 2)}\n`);
}
process.stdout.write(`${files.length} golden files (${read} read, ${files.length - read} refused by cheap-eyes ${ce.version}) in test/golden/\n`);
