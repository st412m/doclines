// One input (a path or bytes) → numbered lines. Plain text is read byte-exact on the
// calling thread; every other format is detected by content and extracted in a worker
// thread with a timeout and a heap cap. Nothing here writes to stdout or stderr.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { DoclinesError } from './errors.js';
import { binaryLabel, classify, damagedFile, EXTRACTED, FORMAT_BY_ID, HTML_TYPES, SNIFF_BYTES, sniff, unsupported } from './formats.js';
import { decoderFor } from './html.js';
import { decode, looksBinary, splitLines } from './read.js';
import { version } from './version.js';

const WORKER_URL = new URL('./extract-worker.js', import.meta.url);
// The head read for detection: the sniffed bytes plus room for a BOM in the binary check.
const HEAD_BYTES = SNIFF_BYTES + 4;

export const DEFAULTS = Object.freeze({
  formats: 'all',
  maxDocBytes: 52428800,
  maxTextBytes: 2097152,
  timeoutMs: 60000,
  heapMb: 1024,
  attachments: Object.freeze({ depth: 1 }),
  text: 'auto',
});

function positive(o, key) {
  const v = o[key] ?? DEFAULTS[key];
  if (!Number.isFinite(v) || v <= 0) throw new TypeError(`doclines: ${key} must be a positive number`);
  return v;
}

function options(input, opts = {}) {
  const isPath = typeof input === 'string';
  if (!isPath && !(input instanceof Uint8Array)) throw new TypeError('doclines: input must be a path or a Buffer/Uint8Array');
  const name = opts.name ?? (isPath ? path.basename(input) : 'input');
  const contentType = opts.contentType ?? null;
  const mime = contentType ? contentType.split(';')[0].trim().toLowerCase() : null;
  // A Content-Type naming HTML counts as the extension .html.
  const ext = HTML_TYPES.has(mime) ? '.html' : (opts.ext ?? path.extname(isPath ? input : name));
  let formats = opts.formats ?? DEFAULTS.formats;
  if (formats !== 'all') {
    if (!Array.isArray(formats)) throw new TypeError("doclines: formats must be 'all' or an array of format ids");
    for (const id of formats) if (!FORMAT_BY_ID.has(id)) throw new TypeError(`doclines: unknown format id ${JSON.stringify(id)}`);
    formats = new Set(formats);
  }
  const text = opts.text ?? DEFAULTS.text;
  if (text !== 'auto' && text !== 'never') throw new TypeError("doclines: text must be 'auto' or 'never'");
  const depth = opts.attachments?.depth ?? DEFAULTS.attachments.depth;
  if (depth !== 0 && depth !== 1) throw new TypeError('doclines: attachments.depth must be 0 or 1');
  return {
    isPath,
    name,
    ext,
    mime,
    contentType,
    formats,
    text,
    attachments: { depth },
    maxDocBytes: positive(opts, 'maxDocBytes'),
    maxTextBytes: positive(opts, 'maxTextBytes'),
    timeoutMs: positive(opts, 'timeoutMs'),
    heapMb: positive(opts, 'heapMb'),
  };
}

// The kind of the input from its head; a message is EML only by its extension .eml or
// the content type message/rfc822 (a text file that starts with "From:" stays text).
function kindOf(head, o) {
  const kind = sniff(head, o.ext);
  if ((kind === 'text' || kind === 'html') && (o.ext.toLowerCase() === '.eml' || o.mime === 'message/rfc822')) return 'eml';
  return kind;
}

function toBuffer(u8) {
  return Buffer.isBuffer(u8) ? u8 : Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
}

// { size, head, read() → Buffer } for a path or bytes; not_a_file for anything else.
async function source(input, o) {
  if (!o.isPath) {
    const buf = toBuffer(input);
    return { size: buf.length, head: buf.subarray(0, HEAD_BYTES), read: async () => buf };
  }
  let st;
  try {
    st = await fs.stat(input);
  } catch (e) {
    if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') throw new DoclinesError('not_a_file', `no such file: ${o.name}`, { reason: 'no such file' });
    throw e;
  }
  if (!st.isFile()) throw new DoclinesError('not_a_file', `not a regular file: ${o.name}`, { reason: 'not a regular file' });
  const fh = await fs.open(input, 'r');
  let head;
  try {
    const b = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(b, 0, HEAD_BYTES, 0);
    head = b.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
  return { size: st.size, head, read: () => fs.readFile(input) };
}

function docTooBig(o, size) {
  return new DoclinesError('too_large', `document too large: ${o.name} (${size} bytes > maxDocBytes ${o.maxDocBytes})`, { reason: 'document too large' });
}

function textTooBig(o, size) {
  return new DoclinesError('text_too_large', `file too large: ${o.name} (${size} bytes > maxTextBytes ${o.maxTextBytes})`, {
    format: 'text',
    label: FORMAT_BY_ID.get('text').label,
    reason: 'file too large',
  });
}

function notAllowed(o, format) {
  const { label } = FORMAT_BY_ID.get(format);
  return new DoclinesError('not_allowed', `format not allowed: ${label} (${o.name})`, { format, label, reason: `format not allowed: ${label}` });
}

function allowed(o, format) {
  if (format === 'text' && o.text === 'never') return false;
  return o.formats === 'all' || o.formats.has(format);
}

function withFormat(e, format) {
  if (e instanceof DoclinesError && e.format === null && FORMAT_BY_ID.has(format)) {
    e.format = format;
    e.label = FORMAT_BY_ID.get(format).label;
  }
  return e;
}

// Container formats are told apart from the whole file; an exception that is not a
// refusal means a damaged container.
function classifyBuffer(buf, kind, o) {
  try {
    return classify(buf, kind, o.name, o.ext, { maxDocBytes: o.maxDocBytes });
  } catch (e) {
    if (e instanceof DoclinesError) throw e;
    throw damagedFile(o.name, kind, String(e?.message ?? e));
  }
}

/**
 * Extract `buf` (format already detected) in a worker. Resolves the worker's answer
 * { format, charset, lines, markers, sections, pageStarts, pagesWithoutText, warnings };
 * refusals reject with DoclinesError.
 */
export function extractInWorker(
  buf,
  {
    format,
    name,
    contentType = null,
    timeoutMs = DEFAULTS.timeoutMs,
    heapMb = DEFAULTS.heapMb,
    maxTextBytes = DEFAULTS.maxTextBytes,
    maxDocBytes = DEFAULTS.maxDocBytes,
    formats = 'all',
    text = 'auto',
    depth = DEFAULTS.attachments.depth,
    workerUrl = WORKER_URL,
  },
) {
  return new Promise((resolve, reject) => {
    const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    const worker = new Worker(workerUrl, {
      workerData: { data, format, name, contentType, maxTextBytes, maxDocBytes, heapMb, formats, text, depth },
      transferList: [data],
      execArgv: [],
      // The worker's own stdout/stderr never reach the host process.
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: heapMb },
    });
    worker.stdout.resume();
    worker.stderr.resume();
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(v);
      worker.terminate();
    };
    const timer = setTimeout(() => {
      finish(reject, withFormat(new DoclinesError('timeout', `extraction timed out after ${timeoutMs / 1000} s: ${name}`, { reason: 'extraction timed out' }), format));
    }, timeoutMs);
    worker.once('message', (m) => {
      if (m.ok) finish(resolve, m);
      else if (m.internal) finish(reject, damagedFile(name, format, m.message));
      else finish(reject, withFormat(DoclinesError.from(m.error), format));
    });
    worker.once('error', (e) => {
      if (done) return;
      if (e?.code === 'ERR_WORKER_OUT_OF_MEMORY') {
        finish(reject, withFormat(new DoclinesError('out_of_memory', `extraction ran out of memory (${heapMb} MB): ${name}`, { reason: 'extraction ran out of memory' }), format));
      } else finish(reject, damagedFile(name, format, e?.message ?? String(e)));
    });
    worker.once('exit', (code) => {
      if (!done) finish(reject, damagedFile(name, format, `worker exited with code ${code}`));
    });
  });
}

// Plain text: UTF-8 or UTF-16 by BOM (the 0.1 rules); a charset in contentType decodes
// text without a BOM.
function decodeText(buf, o) {
  const label = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(o.contentType ?? '')?.[1];
  const hasBom = (buf[0] === 0xef && buf[1] === 0xbb) || (buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff);
  const dec = label && !hasBom ? decoderFor(label, o.name) : null;
  if (dec && dec.encoding !== 'utf-8') {
    if (buf.subarray(0, 8192).includes(0)) throw new DoclinesError('binary', `binary file refused: ${o.name}`, { reason: 'binary file' });
    return { text: dec.decode(buf), encoding: dec.encoding };
  }
  return decode(buf, o.name);
}

function result(format, r, buf) {
  return {
    format,
    label: FORMAT_BY_ID.get(format).label,
    charset: r.charset,
    lines: r.lines,
    markers: r.markers,
    sections: r.sections,
    pageStarts: r.pageStarts,
    pagesWithoutText: r.pagesWithoutText,
    warnings: r.warnings,
    bytes: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'),
    doclinesVersion: version,
  };
}

/** Extract one document: see README for options and the result. */
export async function extract(input, opts = {}) {
  const o = options(input, opts);
  const src = await source(input, o);
  const kind = kindOf(src.head, o);
  if (kind === 'text') {
    if (!allowed(o, 'text')) throw notAllowed(o, 'text');
    if (src.size > o.maxTextBytes) throw textTooBig(o, src.size);
    const buf = await src.read();
    if (buf.length > o.maxTextBytes) throw textTooBig(o, buf.length);
    let d;
    try {
      d = decodeText(buf, o);
    } catch (e) {
      throw e.code === 'binary' ? e : withFormat(e, 'text');
    }
    return result('text', { charset: d.encoding, lines: splitLines(d.text), markers: [], sections: [], pageStarts: null, pagesWithoutText: [], warnings: [] }, buf);
  }
  if (kind === 'binary') throw unsupported(binaryLabel(src.head), o.name);
  if (src.size > o.maxDocBytes) throw docTooBig(o, src.size);
  const buf = await src.read();
  if (buf.length > o.maxDocBytes) throw docTooBig(o, buf.length);
  const format = classifyBuffer(buf, kind, o);
  if (!allowed(o, format)) throw notAllowed(o, format);
  if (!EXTRACTED.has(format)) throw unsupported(FORMAT_BY_ID.get(format).label, o.name, { format });
  const r = await extractInWorker(buf, {
    format,
    name: o.name,
    contentType: o.contentType,
    timeoutMs: o.timeoutMs,
    heapMb: o.heapMb,
    maxTextBytes: o.maxTextBytes,
    maxDocBytes: o.maxDocBytes,
    formats: o.formats === 'all' ? 'all' : [...o.formats],
    text: o.text,
    depth: o.attachments.depth,
  });
  return result(format, r, buf);
}

/**
 * Detect the format without extracting: { format, label, family, textOnDisk,
 * extractable, refusal }. ZIP and OLE files are read whole (up to maxDocBytes) for
 * their container directory.
 */
export async function detect(input, opts = {}) {
  const o = options(input, opts);
  // A text-on-disk format inside a container (FB2 in a ZIP) is not text on disk.
  let packed = false;
  const out = (format, refusal = null, label = null) => {
    const f = format ? FORMAT_BY_ID.get(format) : null;
    return {
      format,
      label: label ?? f?.label ?? null,
      family: f?.family ?? null,
      textOnDisk: !packed && (f?.textOnDisk ?? false),
      extractable: refusal === null,
      refusal,
    };
  };
  const refused = (e) => {
    if (!(e instanceof DoclinesError)) throw e;
    return out(e.format, { code: e.code, message: e.message }, e.label);
  };
  try {
    const src = await source(input, o);
    const kind = kindOf(src.head, o);
    if (kind === 'text') {
      if (!allowed(o, 'text')) throw notAllowed(o, 'text');
      if (looksBinary(src.head)) return out(null, { code: 'binary', message: `binary file refused: ${o.name}` });
      return out('text');
    }
    if (kind === 'binary') throw unsupported(binaryLabel(src.head), o.name);
    let format = kind;
    if (kind === 'zip' || kind === 'ole') {
      if (src.size > o.maxDocBytes) throw docTooBig(o, src.size);
      packed = true;
      format = classifyBuffer(await src.read(), kind, o);
    }
    if (!allowed(o, format)) throw notAllowed(o, format);
    if (!EXTRACTED.has(format)) throw unsupported(FORMAT_BY_ID.get(format).label, o.name, { format });
    return out(format);
  } catch (e) {
    return refused(e);
  }
}
