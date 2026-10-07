// README.md: the formats table matches FORMATS (regenerate with
// `node tools/formats-table.mjs --write`).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { FORMATS } from '../src/index.js';
import { README, formatsTable, tableIn } from '../tools/formats-table.mjs';

test('README: formats table in sync with FORMATS', () => {
  const table = tableIn(fs.readFileSync(README, 'utf8'));
  assert.notEqual(table, null, 'README.md has no formats table markers');
  assert.equal(table, formatsTable(), 'README.md formats table is stale: run node tools/formats-table.mjs --write');
});

test('README: one table row per format id', () => {
  const rows = formatsTable().split('\n').slice(2);
  assert.equal(rows.length, FORMATS.length);
  for (const [i, f] of FORMATS.entries()) assert.ok(rows[i].startsWith(`| \`${f.id}\` | ${f.label} |`));
});
