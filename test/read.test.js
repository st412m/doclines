import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { extract } from '../src/extract.js';
import { decode, looksBinary, splitLines } from '../src/read.js';
import { tmpDir } from './helpers.js';

const utf16le = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
const utf16be = (s) => {
  const b = Buffer.from(s, 'utf16le');
  b.swap16();
  return Buffer.concat([Buffer.from([0xfe, 0xff]), b]);
};

test('UTF-8 with and without BOM', () => {
  assert.equal(decode(Buffer.from('\uFEFFпривет\n', 'utf8')).text, 'привет\n');
  assert.equal(decode(Buffer.from('plain', 'utf8')).encoding, 'utf-8');
});

test('UTF-16 LE (PowerShell 5.1 ">") and BE by BOM', () => {
  const le = decode(utf16le('строка 1\r\nline 2\r\n'));
  assert.equal(le.encoding, 'utf-16le');
  assert.deepEqual(splitLines(le.text), ['строка 1', 'line 2']);
  const be = decode(utf16be('a\nб\n'));
  assert.equal(be.encoding, 'utf-16be');
  assert.deepEqual(splitLines(be.text), ['a', 'б']);
});

test('binary: NUL in the first 8 KB, checked after BOM detection', () => {
  assert.throws(() => decode(Buffer.from([0x41, 0x00, 0x42]), 'x.bin'), (e) => e.code === 'binary' && e.message === 'binary file refused: x.bin');
  assert.throws(() => decode(utf16le('a\u0000b'), 'y'), /binary/);
  const late = Buffer.concat([Buffer.alloc(9000, 0x41), Buffer.from([0])]);
  assert.doesNotThrow(() => decode(late));
  assert.equal(looksBinary(Buffer.from([0x41, 0x00])), true);
  assert.equal(looksBinary(late), false);
});

test('splitLines strips \\r and keeps numbering', () => {
  assert.deepEqual(splitLines('a\r\nb\rc\n'), ['a', 'bc']);
  assert.deepEqual(splitLines('a\n\nb'), ['a', '', 'b']);
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('\n'), ['']);
});

test('a text file over maxTextBytes is refused, naming the file', async () => {
  const d = tmpDir();
  const f = path.join(d, 'big.log');
  fs.writeFileSync(f, 'x'.repeat(100));
  await assert.rejects(extract(f, { maxTextBytes: 99, name: f }), (e) => e.code === 'text_too_large' && e.message.includes('file too large') && e.message.includes(f));
  assert.equal((await extract(f, { maxTextBytes: 100 })).lines.length, 1);
});
