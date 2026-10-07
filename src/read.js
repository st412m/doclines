// Decoding: UTF-8 (BOM stripped) or UTF-16 LE/BE by BOM; binary detection; line split.
import { DoclinesError } from './errors.js';

const BINARY_PROBE = 8192;

function binary(name) {
  return new DoclinesError('binary', `binary file refused: ${name}`, { reason: 'binary file' });
}

// Returns { text, encoding } or throws DoclinesError `binary`.
export function decode(buf, name = 'input') {
  let encoding = 'utf-8';
  let body = buf;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    body = buf.subarray(3);
  } else if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    encoding = 'utf-16le';
    body = buf.subarray(2);
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    encoding = 'utf-16be';
    body = buf.subarray(2);
  }

  let text;
  if (encoding === 'utf-8') {
    if (body.subarray(0, BINARY_PROBE).includes(0)) throw binary(name);
    text = new TextDecoder('utf-8').decode(body);
  } else {
    const even = body.length - (body.length % 2);
    let units = Buffer.from(body.subarray(0, even));
    if (encoding === 'utf-16be') units.swap16();
    text = units.toString('utf16le');
    if (text.slice(0, BINARY_PROBE / 2).includes('\u0000')) throw binary(name);
  }
  return { text, encoding };
}

// The binary check of `decode` on the first bytes only (detection).
export function looksBinary(head) {
  try {
    decode(head.subarray(0, BINARY_PROBE + 3));
    return false;
  } catch {
    return true;
  }
}

// Lines without `\r`, numbered from 1 by index + 1. A trailing newline adds no line.
export function splitLines(text) {
  if (text === '') return [];
  const lines = text.replace(/\r/g, '').split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}
