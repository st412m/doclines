// E-mail messages → head lines (From, To, Cc, Date, Subject, those present), an empty
// line, the body; then "--- attachments ---" listing every attachment as
// "name (mime type, N bytes)" and, with attachments.depth 1, each attachment extracted
// under "--- attachment: <name> ---" (an attachment inside it is listed only).
// EML (RFC 5322/2045/2047) through postal-mime: the text/plain body, else the HTML body
// through the HTML extractor. MSG (Outlook item) through @kenjiuno/msgreader: the plain
// body, else the HTML body, else the compressed RTF body through the RTF decoder.
import { isMainThread } from 'node:worker_threads';
import decompressrtf from '@kenjiuno/decompressrtf';
import msgreader from '@kenjiuno/msgreader';
import PostalMime from 'postal-mime';
import { decodeHtml, htmlToText } from './html.js';
import { markerLabel } from './normalize.js';
import { rtfToText } from './rtf.js';
import { windows1252 } from './windows-1252.js';

// Both are CommonJS: the default import is module.exports.
const MsgReader = msgreader.default ?? msgreader;
const { decompressRTF } = decompressrtf;

// postal-mime decodes bodies with TextDecoder; windows-1252 goes through the own table
// (windows-1252.js). Installed in the extraction worker only.
let decoderInstalled = false;
function installWindows1252() {
  if (decoderInstalled || isMainThread) return;
  decoderInstalled = true;
  const Native = globalThis.TextDecoder;
  globalThis.TextDecoder = class TextDecoder extends Native {
    decode(input, options) {
      return this.encoding === 'windows-1252' ? windows1252.decode(input ?? new Uint8Array(0)) : super.decode(input, options);
    }
  };
}

function mailbox(a) {
  if (!a) return '';
  if (a.group) return `${a.name ? `${a.name}: ` : ''}${a.group.map(mailbox).join(', ')};`;
  if (!a.address) return a.name ?? '';
  return a.name && a.name !== a.address ? `${a.name} <${a.address}>` : a.address;
}

function headLines(fields) {
  const out = [];
  for (const [key, value] of fields) {
    const v = String(value ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
    if (v) out.push(`${key}: ${v}`);
  }
  return out;
}

/**
 * The sections of a message: head and body, then the attachment list and, with
 * ctx.depth >= 1, each attachment extracted (ctx.extractAttachment).
 */
async function messageSections(head, body, attachments, ctx) {
  const sections = [{ marker: null, text: [...head, '', body].join('\n') }];
  if (!attachments.length) return sections;
  const list = attachments.map((a) => `${a.name} (${a.mime}, ${a.bytes.length} bytes)`);
  sections.push({ marker: '--- attachments ---', kind: 'attachments', n: null, label: null, text: list.join('\n') });
  if (ctx.depth < 1) return sections;
  for (const a of attachments) {
    let inner;
    try {
      inner = await ctx.extractAttachment(a);
    } catch (e) {
      if (e?.name !== 'DoclinesError') throw e;
      inner = [{ marker: null, text: `(not extracted: ${e.reason ?? e.message})` }];
    }
    sections.push({ marker: `--- attachment: ${markerLabel(a.name)} ---`, kind: 'attachment', n: null, label: a.name, text: '', sections: inner });
  }
  return sections;
}

const toBuffer = (c) => (Buffer.isBuffer(c) ? c : typeof c === 'string' ? Buffer.from(c) : Buffer.from(c instanceof ArrayBuffer ? new Uint8Array(c) : c));

/**
 * The body of a parsed message: its text/plain part, else its HTML through the HTML
 * extractor. postal-mime renders an HTML-only body as text itself; which parts the
 * message has is read from the parser's `textTypes` (internal to postal-mime 4.1.4).
 * Without it, the HTML when there is one, else the text.
 */
export function emlBody(email, parser) {
  const types = parser?.textTypes;
  const hasPlain = types instanceof Set ? types.has('plain') : !email.html;
  if (hasPlain) return email.text ?? '';
  return email.html ? htmlToText(email.html, { title: false }) : (email.text ?? '');
}

export async function extractEml(buf, ctx) {
  installWindows1252();
  const parser = new PostalMime({ forceRfc822Attachments: true, attachmentEncoding: 'arraybuffer' });
  const email = await parser.parse(buf);
  const header = (key) => email.headers.find((h) => h.key === key)?.value ?? null;
  const head = headLines([
    ['From', mailbox(email.from)],
    ['To', (email.to ?? []).map(mailbox).join(', ')],
    ['Cc', (email.cc ?? []).map(mailbox).join(', ')],
    ['Date', header('date')],
    ['Subject', email.subject],
  ]);
  const body = emlBody(email, parser);
  ctx.guard(body);
  let n = 0;
  const attachments = email.attachments.map((a) => {
    n++;
    const mime = (a.mimeType || 'application/octet-stream').toLowerCase();
    const name = a.filename || (mime === 'message/rfc822' ? `message ${n}.eml` : `attachment ${n}`);
    return { name, mime, bytes: toBuffer(a.content) };
  });
  // The charset of a single-part message body; multipart bodies may mix several.
  const ct = header('content-type') ?? '';
  const charset = /^\s*text\//i.test(ct) ? (/charset\s*=\s*"?([^";\s]+)/i.exec(ct)?.[1]?.toLowerCase() ?? 'us-ascii') : null;
  return { charset, sections: await messageSections(head, body, attachments, ctx) };
}

function iso(t) {
  const d = t ? new Date(t) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().replace(/\.000Z$/, 'Z') : null;
}

export function msgBody(d) {
  if (d.body && d.body.trim()) return d.body;
  if (d.bodyHtml) return htmlToText(d.bodyHtml, { title: false });
  if (d.html?.length) return htmlToText(decodeHtml(Buffer.from(d.html)).text, { title: false });
  if (d.compressedRtf?.length) return rtfToText(Buffer.from(decompressRTF(Array.from(d.compressedRtf)))).body;
  return '';
}

export async function extractMsg(buf, ctx) {
  const reader = new MsgReader(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  const d = reader.getFileData();
  if (d.error) throw new Error(`MSG: ${d.error}`);
  const person = (name, email) => mailbox({ name: name ?? '', address: email ?? '' });
  const recips = (type) => (d.recipients ?? []).filter((r) => r.recipType === type).map((r) => person(r.name, r.smtpAddress ?? r.email)).join(', ');
  const sender = d.senderSmtpAddress ?? (d.senderAddressType === 'EX' ? null : d.senderEmail);
  const head = headLines([
    ['From', person(d.senderName, sender)],
    ['To', recips('to')],
    ['Cc', recips('cc')],
    ['Date', iso(d.clientSubmitTime ?? d.messageDeliveryTime ?? d.creationTime)],
    ['Subject', d.subject],
  ]);
  const body = msgBody(d);
  ctx.guard(body);
  const attachments = (d.attachments ?? []).map((a, i) => {
    const file = reader.getAttachment(a);
    const mime = (a.attachMimeTag || (a.innerMsgContent ? 'application/vnd.ms-outlook' : 'application/octet-stream')).toLowerCase();
    return { name: file.fileName || a.fileName || a.name || `attachment ${i + 1}`, mime, bytes: Buffer.from(file.content ?? []) };
  });
  return { sections: await messageSections(head, body, attachments, ctx) };
}
