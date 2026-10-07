import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { after } from 'node:test';

export const ROOT = path.join(import.meta.dirname, '..');
export const FX = path.join(ROOT, 'test', 'fixtures', 'formats');
export const FIXTURES = JSON.parse(fs.readFileSync(path.join(FX, 'fixtures.json'), 'utf8'));
export const fx = (name) => fs.readFileSync(path.join(FX, name));
export const fxPath = (name) => path.join(FX, name);
export const CLI = path.join(ROOT, 'src', 'cli.js');
export const FAKE_WORKER = pathToFileURL(path.join(ROOT, 'test', 'fixtures', 'fake-extract-worker.mjs'));
export const srcUrl = (file) => pathToFileURL(path.join(ROOT, 'src', file)).href;

// A fresh temp dir per call, removed when the test file finishes. Resolved with the
// native realpath: on Windows the JS realpath keeps 8.3 short names.
export function tmpDir(prefix = 'doclines-') {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A ZIP holding the given entries, built in memory: stored, or deflated with
// `deflate: true`; `size` overrides the declared uncompressed size, `flags` the
// general purpose bits.
export function zip(entries) {
  const locals = [];
  const centrals = [];
  let off = 0;
  for (const { name, data = '', deflate = false, size, flags = 0 } of entries) {
    const n = Buffer.from(name);
    const raw = Buffer.from(data);
    const d = deflate ? zlib.deflateRawSync(raw) : raw;
    const declared = size ?? raw.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(d.length, 18);
    lh.writeUInt32LE(declared, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(d.length, 20);
    ch.writeUInt32LE(declared, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(off, 42);
    locals.push(lh, n, d);
    centrals.push(ch, n);
    off += 30 + n.length + d.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

// Asserts a DoclinesError with `code` whose message matches `re` (optional).
export function isRefusal(code, re) {
  return (e) => {
    if (e?.name !== 'DoclinesError') throw e;
    if (e.code !== code) throw new Error(`expected code ${code}, got ${e.code}: ${e.message}`);
    if (re && !re.test(e.message)) throw new Error(`message ${JSON.stringify(e.message)} does not match ${re}`);
    return true;
  };
}
