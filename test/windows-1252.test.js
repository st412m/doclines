// windows-1252 by the own table (Node 22.13–22.22.0 and 24.0–24.13 decode 0x80–0x9F
// as C1 controls, nodejs/node#60888), in HTML, RTF and plain text with a charset.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extract } from '../src/index.js';
import { decoderFor } from '../src/html.js';
import { rtfToText } from '../src/rtf.js';
import { decoderForLabel, windows1252 } from '../src/windows-1252.js';

// https://encoding.spec.whatwg.org/index-windows-1252.txt, pointers 0–31 (bytes 0x80–0x9F).
const WHATWG_80_9F = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

test('all 32 bytes 0x80–0x9F against the WHATWG index; the rest is the same code point', () => {
  for (let i = 0; i < 32; i++) {
    const got = windows1252.decode(Uint8Array.of(0x80 + i));
    assert.equal(got.codePointAt(0), WHATWG_80_9F[i], `byte 0x${(0x80 + i).toString(16)}`);
    assert.equal(got.length, 1);
  }
  const all = Uint8Array.from({ length: 256 }, (_, b) => b);
  const s = windows1252.decode(all);
  assert.equal(s.length, 256);
  for (let b = 0; b < 256; b++) if (b < 0x80 || b > 0x9f) assert.equal(s.charCodeAt(b), b);
  // Long input crosses the internal chunks; Buffer, ArrayBuffer and views decode alike.
  const long = Buffer.alloc(20000, 0x93);
  assert.equal(windows1252.decode(long), '“'.repeat(20000));
  assert.equal(windows1252.decode(long.buffer.slice(long.byteOffset, long.byteOffset + 3)), '“““');
  assert.equal(windows1252.decode(), '');
});

test('every label WHATWG maps to windows-1252 gets the own decoder; other code pages stay TextDecoder', () => {
  for (const l of ['windows-1252', 'cp1252', 'latin1', 'iso-8859-1', 'ISO_8859-1', 'ascii', 'us-ascii', 'l1', 'x-cp1252']) {
    assert.equal(decoderForLabel(l), windows1252, l);
    assert.equal(decoderFor(l, 'x'), windows1252, l);
  }
  for (const l of ['windows-1251', 'koi8-r', 'shift_jis', 'utf-8']) {
    const d = decoderForLabel(l);
    assert.ok(d instanceof TextDecoder, l);
  }
  assert.throws(() => decoderForLabel('no-such-charset'), RangeError);
});

test('HTML: meta charset windows-1252 and iso-8859-1 decode quotes, dashes and the euro sign', async () => {
  for (const cs of ['windows-1252', 'iso-8859-1']) {
    const page = Buffer.concat([Buffer.from(`<html><head><meta charset="${cs}"></head><body><p>`), Buffer.from([0x93, 0x41, 0x94, 0x20, 0x96, 0x20, 0x80, 0x35, 0x20, 0x99]), Buffer.from('</p></body></html>')]);
    const r = await extract(page, { name: 'p.html' });
    assert.deepEqual([r.format, r.charset, r.lines], ['html', 'windows-1252', ['“A” – €5 ™']], cs);
  }
});

test('RTF: \\ansicpg1252 and the default code page decode \\\'93\\\'94', async () => {
  assert.equal(rtfToText(Buffer.from("{\\rtf1\\ansi\\ansicpg1252 \\'93quoted\\'94 \\'80\\par}", 'latin1')).body, '“quoted” €');
  assert.equal(rtfToText(Buffer.from("{\\rtf1\\ansi \\'93x\\'94\\par}", 'latin1')).body, '“x”');
  const r = await extract(Buffer.from("{\\rtf1\\ansi\\ansicpg1252{\\fonttbl{\\f0\\fcharset0 A;}}\\f0 \\'91a\\'92 \\'85\\par}", 'latin1'), { name: 'q.rtf' });
  assert.deepEqual(r.lines, ['‘a’ …']);
});

test('plain text with contentType charset=iso-8859-1', async () => {
  const r = await extract(Buffer.from([0x93, 0x68, 0x69, 0x94, 0x0a, 0x9f, 0x0a]), { contentType: 'text/plain; charset=iso-8859-1' });
  assert.deepEqual([r.format, r.charset, r.lines], ['text', 'windows-1252', ['“hi”', 'Ÿ']]);
});
