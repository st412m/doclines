// Extraction of one document, off the main thread so a hostile file can be killed on
// a timeout. Refusals come back as { ok: false, error }; anything else as
// { ok: false, internal: true, message } and is never shown to the caller verbatim.
// Attachments of a message are extracted here too, in the same worker.
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
// First: nothing this thread prints may reach the host's stdout or stderr.
import { consoleWarnings } from './quiet.js';
// Module hooks are per thread, and pdfjs (imported later) must never load
// @napi-rs/canvas.
import './no-canvas.js';
// Also before pdfjs: keep U+00AD in pdfjs text content (keep-soft-hyphen.js).
import './keep-soft-hyphen.js';
import { attachmentBudget } from './attachments.js';
import { DoclinesError } from './errors.js';
import { binaryLabel, classify, damagedFile, EXTRACTED, FORMAT_BY_ID, fromZipError, HTML_TYPES, SNIFF_BYTES, sniff, unsupported } from './formats.js';
import { heapCapWarning } from './heap.js';
import { decodeHtml, decoderFor, htmlToText } from './html.js';
import { assemble } from './normalize.js';
import { decode, looksBinary } from './read.js';
import { rtfToText } from './rtf.js';
import { ZipError } from './zip.js';

const { data, format, name, contentType, maxTextBytes, maxDocBytes, heapMb, formats, text: textOption, depth } = workerData;

const tooLarge = () => new DoclinesError('text_too_large', `extracted text too large: ${name} (over ${maxTextBytes} bytes)`, { reason: 'extracted text too large' });

const allowed = (f) => (f === 'text' && textOption === 'never' ? false : formats === 'all' || formats.includes(f));

const EXTRACTORS = {
  async pdf(buf, ctx) {
    const { extractPdf } = await import('./pdf.js');
    const r = await extractPdf(buf, ctx.name);
    if (r.warning) ctx.warn(r.warning);
    return r;
  },
  async docx(buf, ctx) {
    const { extractDocx } = await import('./docx.js');
    return { sections: await extractDocx(buf, ctx) };
  },
  async doc(buf) {
    const { extractDoc } = await import('./doc.js');
    return { sections: await extractDoc(buf) };
  },
  rtf(buf, ctx) {
    const r = rtfToText(buf, ctx.name);
    const sections = [{ marker: null, text: r.body }];
    if (r.footnotes.trim() !== '') sections.push({ marker: '--- footnotes ---', kind: 'footnotes', text: r.footnotes });
    return { sections };
  },
  html(buf, ctx) {
    const d = decodeHtml(buf, { contentType: ctx.contentType, name: ctx.name });
    return { charset: d.charset, sections: [{ marker: null, text: htmlToText(d.text) }] };
  },
  async xlsx(buf, ctx) {
    return (await import('./xlsx.js')).extractXlsx(buf, ctx);
  },
  async ods(buf, ctx) {
    return (await import('./ods.js')).extractOds(buf, ctx);
  },
  async pptx(buf, ctx) {
    return (await import('./pptx.js')).extractPptx(buf, ctx);
  },
  async odp(buf, ctx) {
    return (await import('./odp.js')).extractOdp(buf, ctx);
  },
  async odt(buf, ctx) {
    return (await import('./odt.js')).extractOdt(buf, ctx);
  },
  async epub(buf, ctx) {
    return (await import('./epub.js')).extractEpub(buf, ctx);
  },
  async fb2(buf, ctx) {
    return (await import('./fb2.js')).extractFb2(buf, ctx);
  },
  async xls(buf, ctx) {
    return (await import('./xls.js')).extractXls(buf, ctx);
  },
  async ppt(buf, ctx) {
    return (await import('./ppt.js')).extractPpt(buf, ctx);
  },
  async eml(buf, ctx) {
    return (await import('./mail.js')).extractEml(buf, ctx);
  },
  async msg(buf, ctx) {
    return (await import('./mail.js')).extractMsg(buf, ctx);
  },
};

// The format of an attachment, detected as the calling thread detects a file; a
// refusal throws. An attached message is EML by its name or type.
function attachmentFormat(a) {
  const ext = path.extname(a.name).toLowerCase();
  const head = a.bytes.subarray(0, SNIFF_BYTES + 4);
  const kind = sniff(head, HTML_TYPES.has(a.mime) ? '.html' : ext);
  if ((kind === 'text' || kind === 'html') && (ext === '.eml' || a.mime === 'message/rfc822')) return 'eml';
  if (kind === 'binary') throw unsupported(binaryLabel(head), a.name);
  if (kind === 'text') {
    if (looksBinary(head)) throw new DoclinesError('binary', `binary file refused: ${a.name}`, { reason: 'binary file' });
    return 'text';
  }
  return classify(a.bytes, kind, a.name, ext, { maxDocBytes });
}

// Shared by the document and its attachments: warnings, the raw-text guard (text far
// over maxTextBytes is refused before it is all in memory; the exact count runs in
// assemble) and the maxDocBytes budget of the attachments: their decoded bytes
// together, apart from the message's own size (which holds them encoded).
function context() {
  const warnings = [];
  let units = 0;
  const textBudget = maxTextBytes * 4 + 2 ** 20;
  const docBudget = attachmentBudget(maxDocBytes);
  const ctx = {
    name,
    contentType,
    maxDocBytes,
    depth,
    warnings,
    warn(w) {
      if (!warnings.includes(w)) warnings.push(w);
    },
    guard(s) {
      units += s.length + 1;
      if (units > textBudget) throw tooLarge();
    },
    // One attachment → its sections, or a DoclinesError for the "(not extracted: …)" line.
    async extractAttachment(a) {
      docBudget.take(a.name, a.bytes.length);
      const f = attachmentFormat(a);
      const { label } = FORMAT_BY_ID.get(f);
      if (!allowed(f)) throw new DoclinesError('not_allowed', `format not allowed: ${label} (${a.name})`, { format: f, label, reason: `format not allowed: ${label}` });
      if (!EXTRACTED.has(f)) throw unsupported(label, a.name, { format: f });
      if (f === 'text') {
        const cs = /charset\s*=\s*"?([^";\s]+)/i.exec(a.mime)?.[1];
        const dec = cs ? decoderFor(cs, a.name) : null;
        return [{ marker: null, text: dec && dec.encoding !== 'utf-8' ? dec.decode(a.bytes) : decode(a.bytes, a.name).text }];
      }
      const child = { ...ctx, name: a.name, contentType: a.mime, depth: ctx.depth - 1 };
      try {
        return (await EXTRACTORS[f](a.bytes, child)).sections;
      } catch (e) {
        if (e instanceof DoclinesError) throw e;
        if (e instanceof ZipError) throw fromZipError(e, a.name, f);
        throw damagedFile(a.name, f, String(e?.message ?? e));
      }
    },
  };
  return ctx;
}

async function run() {
  const buf = Buffer.from(data);
  const ctx = context();
  const heap = heapCapWarning(heapMb);
  if (heap) ctx.warn(heap);
  const extractor = EXTRACTORS[format];
  if (!extractor) throw new Error(`no extractor for ${format}`);
  let r;
  try {
    r = await extractor(buf, ctx);
  } catch (e) {
    if (e instanceof ZipError) throw fromZipError(e, name, format);
    throw e;
  }
  const out = assemble(r.sections, { maxTextBytes, tooLarge });
  return { ok: true, format, charset: r.charset ?? null, pagesWithoutText: r.pagesWithoutText ?? [], ...out, warnings: [...ctx.warnings, ...consoleWarnings()] };
}

run().then(
  (r) => parentPort.postMessage(r),
  (e) => {
    if (e instanceof DoclinesError) parentPort.postMessage({ ok: false, error: e.toJSON() });
    else parentPort.postMessage({ ok: false, internal: true, message: String(e?.message ?? e) });
  },
);
