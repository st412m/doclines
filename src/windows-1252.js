// windows-1252 by its own table. Node 22.13–22.22.0 and 24.0–24.13 decode bytes
// 0x80–0x9F as U+0080–U+009F (nodejs/node#60888), so TextDecoder is never used for
// it, nor for the labels WHATWG maps to it (latin1, iso-8859-1, ascii, cp1252, …).
// Table: https://encoding.spec.whatwg.org/index-windows-1252.txt (pointers 0–31 =
// bytes 0x80–0x9F; 0x00–0x7F and 0xA0–0xFF are the same code point). The five bytes
// the table maps to C1 controls (0x81, 0x8D, 0x8F, 0x90, 0x9D) stay C1 controls.

export const HIGH = Object.freeze([
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
]);

const CHUNK = 8192;

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return new Uint8Array(input);
}

/** Same shape as the TextDecoder use in this package: `encoding` and `decode(bytes)`. */
export const windows1252 = Object.freeze({
  encoding: 'windows-1252',
  decode(input = new Uint8Array(0)) {
    const bytes = toBytes(input);
    const units = new Uint16Array(Math.min(bytes.length, CHUNK));
    let out = '';
    for (let start = 0; start < bytes.length; start += CHUNK) {
      const end = Math.min(start + CHUNK, bytes.length);
      for (let i = start; i < end; i++) {
        const b = bytes[i];
        units[i - start] = b >= 0x80 && b <= 0x9f ? HIGH[b - 0x80] : b;
      }
      out += String.fromCharCode.apply(null, units.subarray(0, end - start));
    }
    return out;
  },
});

/** A decoder for a WHATWG label: the own windows-1252 table, else TextDecoder. Throws as TextDecoder does for an unknown label. */
export function decoderForLabel(label) {
  const d = new TextDecoder(label);
  return d.encoding === 'windows-1252' ? windows1252 : d;
}
