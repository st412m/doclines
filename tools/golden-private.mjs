#!/usr/bin/env node
// Compares cheap-eyes 0.2 and doclines on every file under <dir> (recursively) and
// prints a summary to stdout; nothing is written. Byte comparison only where
// cheap-eyes 0.2 reads the file and the doclines format is text, html, pdf, docx, doc
// or rtf; other files are listed separately and are not counted as differences.
//
//   node tools/golden-private.mjs <dir> --cheap-eyes <cheap-eyes-dir>
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { detect, extract } from '../src/index.js';
import { COMPARED, difference, loadCheapEyes, viewOfCheapEyes, viewOfDoclines } from './golden-lib.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'cheap-eyes': { type: 'string' } } });
if (positionals.length !== 1 || !values['cheap-eyes']) {
  process.stderr.write('usage: node tools/golden-private.mjs <dir> --cheap-eyes <cheap-eyes-dir>\n');
  process.exit(1);
}
const root = path.resolve(positionals[0]);
const ce = await loadCheapEyes(path.resolve(values['cheap-eyes']));

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

const same = [];
const differ = [];
const other = [];
for (const file of walk(root)) {
  const rel = path.relative(root, file);
  let a;
  try {
    a = viewOfCheapEyes(await ce.readSource(file));
  } catch (e) {
    if (e?.name !== 'InputError') throw e;
    const d = await detect(file);
    other.push(`${rel}: cheap-eyes ${ce.version} refused (${e.reason ?? e.message}); doclines ${d.format ?? '-'}${d.refusal ? ` refused (${d.refusal.code})` : ''}`);
    continue;
  }
  let b;
  try {
    b = await extract(file);
  } catch (e) {
    if (e?.name !== 'DoclinesError') throw e;
    if (e.format === null || COMPARED.has(e.format)) differ.push(`${rel}: cheap-eyes read it (${a.format}), doclines refused: ${e.code} (${e.message})`);
    else other.push(`${rel}: cheap-eyes ${a.format}; doclines ${e.format} refused (${e.code})`);
    continue;
  }
  if (!COMPARED.has(b.format)) {
    other.push(`${rel}: cheap-eyes ${a.format}; doclines ${b.format} (own format, not compared)`);
    continue;
  }
  const diff = difference(a, viewOfDoclines(b));
  if (diff) differ.push(`${rel}: ${diff}`);
  else same.push(`${rel} (${b.format}, ${b.lines.length} lines)`);
}

const list = (title, xs) => `${title}: ${xs.length}\n${xs.map((x) => `  ${x}\n`).join('')}`;
process.stdout.write(
  `cheap-eyes ${ce.version} vs doclines on ${root}\n` + list('identical', same) + list('different', differ) + list('not compared', other),
);
process.exitCode = differ.length ? 1 : 0;
