// Messages: EML and MSG, charsets and RFC 2047, body choice, attachments at depth 0
// and 1, the shared maxDocBytes budget, the format allowlist for attachments.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { detect, extract, sectionOf } from '../src/index.js';
import { attachmentBudget } from '../src/attachments.js';
import { emlBody, msgBody } from '../src/mail.js';
import { fx, fxPath } from './helpers.js';

const eml = (s) => Buffer.from(s.replace(/\n/g, '\r\n'), 'latin1');

test('EML: head lines as written, RFC 2047 words decoded, koi8-r quoted-printable text/plain preferred over HTML', async () => {
  const r = await extract(fxPath('mail-mixed.eml'));
  assert.equal(r.format, 'eml');
  assert.deepEqual(r.lines.slice(0, 6), [
    'From: Иван Тестов <ivan@example.com>',
    'To: buyer@example.org',
    'Cc: audit@example.net',
    'Date: Tue, 17 Feb 2026 11:00:00 +0300',
    'Subject: Заявка на поставку — фикстура',
    '',
  ]);
  assert.ok(r.lines.includes('Срок исполнения контракта: 27 ноября 2026 года.'));
  assert.ok(!r.lines.join('\n').includes('HTML alternative must not be used'));
  const html = await extract(fxPath('mail-html-only.eml'));
  assert.deepEqual(html.lines, ['From: shop@example.com', 'To: buyer@example.org', 'Date: Wed, 18 Feb 2026 10:00:00 +0300', 'Subject: Только HTML', '', 'Только HTML-версия письма.', 'Мука | 2 м | 8']);
});

test('EML: windows-1252 and latin1 bodies through the own table; Q-encoded words; groups; charset of a single-part body', async () => {
  for (const cs of ['windows-1252', 'iso-8859-1']) {
    const msg = eml(`From: =?iso-8859-1?Q?Jos=E9_Garc=EDa?= <jose@example.com>\nTo: Team: a@example.com, b@example.com;\nSubject: =?utf-8?Q?Caf=C3=A9_menu?=\nContent-Type: text/plain; charset=${cs}\nContent-Transfer-Encoding: quoted-printable\n\n=93Quoted=94 =96 =80 5\n`);
    const r = await extract(msg, { name: 'q.eml' });
    assert.deepEqual(r.lines, ['From: José García <jose@example.com>', 'To: Team: a@example.com, b@example.com;', 'Subject: Café menu', '', '“Quoted” – € 5'], cs);
    assert.equal(r.charset, cs.toLowerCase());
  }
  assert.equal((await extract(fxPath('mail-mixed.eml'))).charset, null, 'multipart: no single charset');
});

test('EML only by extension .eml or content type message/rfc822; a text file starting with "From:" stays text', async () => {
  const msg = eml('From: a@example.com\nSubject: Hi\n\nbody\n');
  assert.equal((await extract(msg, { name: 'note.txt' })).format, 'text');
  assert.equal((await extract(msg, { name: 'note.eml' })).format, 'eml');
  assert.equal((await extract(msg, { contentType: 'message/rfc822' })).format, 'eml');
  assert.deepEqual((await detect(fxPath('mail-mixed.eml'))).format, 'eml');
  assert.equal((await detect(fxPath('mail-mixed.eml'))).textOnDisk, true);
});

test('attachments depth 1: list, then each extracted under its marker; refused ones get one line; nested ones are listed only', async () => {
  const r = await extract(fxPath('mail-mixed.eml'));
  const text = r.lines.join('\n');
  assert.deepEqual(
    r.markers.map((m) => m.text),
    ['--- attachments ---', '--- attachment: text.docx ---', '--- attachment: pixel.png ---', '--- attachment: forwarded.eml ---', '--- attachments ---'],
  );
  assert.ok(r.lines.includes('Temperature | −40 | 105'));
  assert.ok(r.lines.includes('(not extracted: unsupported format: image (PNG), no OCR)'));
  assert.ok(r.lines.includes('Inner message body text.'));
  assert.ok(text.includes('inner.txt (text/plain, 31 bytes)'));
  assert.ok(!text.includes('Inner attachment text (depth 2)'));
  assert.ok(!r.markers.some((m) => m.text.includes('inner.txt')));
  // Sections nest: the inner message's attachment list lies inside its attachment section.
  const kinds = r.sections.map((s) => [s.kind, s.label]);
  assert.deepEqual(kinds, [['attachments', null], ['attachment', 'text.docx'], ['attachment', 'pixel.png'], ['attachment', 'forwarded.eml'], ['attachments', null]]);
  const fwd = r.sections[3];
  const inner = r.sections[4];
  assert.ok(inner.start >= fwd.start && inner.end <= fwd.end);
  assert.equal(sectionOf(r, inner.start).kind, 'attachments');
  assert.equal(sectionOf(r, r.lines.indexOf('Temperature | −40 | 105') + 1).label, 'text.docx');
});

test('attachments depth 0: listed only', async () => {
  const r = await extract(fxPath('mail-mixed.eml'), { attachments: { depth: 0 } });
  assert.deepEqual(r.markers.map((m) => m.text), ['--- attachments ---']);
  assert.ok(!r.lines.includes('Temperature | −40 | 105'));
  const msg = await extract(fxPath('msg-attachments.msg'), { attachments: { depth: 0 } });
  assert.deepEqual(msg.markers.map((m) => m.text), ['--- attachments ---']);
});

test('maxDocBytes: the decoded attachments of a call together, apart from the message size', async () => {
  const size = fs.statSync(fxPath('mail-mixed.eml')).size;
  // The message is more than half of maxDocBytes; its attachments (6001 + 69 + 465 bytes) fit beside it.
  const maxDocBytes = Math.ceil(size * 1.2);
  assert.ok(size > maxDocBytes / 2 && 6001 + 69 + 465 < maxDocBytes);
  const r = await extract(fxPath('mail-mixed.eml'), { maxDocBytes });
  assert.ok(r.lines.includes('Temperature | −40 | 105'), 'the DOCX attachment is extracted');
  assert.ok(r.lines.includes('Inner message body text.'));
  assert.ok(!r.lines.some((l) => l.startsWith('(not extracted: document too large')));
  // Encoding only grows content, so one message cannot carry more decoded attachment
  // bytes than its own size: the budget running out is checked on the budget itself.
  const budget = attachmentBudget(10_000);
  budget.take('a.pdf', 6000);
  assert.equal(budget.left, 4000);
  assert.throws(
    () => budget.take('b.pdf', 6000),
    (e) => e.code === 'too_large' && e.reason === 'document too large' && e.message === 'document too large: b.pdf (6000 bytes > the 4000 left of maxDocBytes 10000 for attachments)',
  );
  budget.take('c.txt', 4000);
  assert.equal(budget.left, 0);
});

test('attachments share the call limits: the format allowlist, maxTextBytes', async () => {
  const only = await extract(fxPath('mail-mixed.eml'), { formats: ['eml'] });
  assert.ok(only.lines.includes('(not extracted: format not allowed: Word document (.docx))'));
  assert.ok(only.lines.includes('Inner message body text.'));
  await assert.rejects(extract(fxPath('mail-mixed.eml'), { maxTextBytes: 800 }), (e) => e.code === 'text_too_large' && e.format === 'eml');
});

test('MSG: head and body, attachments in order, embedded message extracted with its attachments listed', async () => {
  const simple = await extract(fxPath('msg-simple.msg'));
  assert.deepEqual([simple.format, simple.lines], ['msg', ['Date: 2025-08-10T15:30:57Z', 'Subject: Simple', '', 'Simple']]);
  const att = await extract(fxPath('msg-attachments.msg'));
  assert.deepEqual(att.markers.map((m) => m.text), ['--- attachments ---', ...['A', 'B', 'C', 'D'].map((x) => `--- attachment: ${x}.docx ---`)]);
  assert.deepEqual(att.lines.slice(-4), ['A', 'B', 'C', 'D']);
  const nested = await extract(fxPath('msg-nested.msg'));
  assert.ok(nested.lines.includes('I have attachments!'));
  assert.ok(nested.lines.includes('green.png (application/octet-stream, 134 bytes)'));
  assert.ok(!nested.markers.some((m) => m.text.includes('green.png')));
  assert.ok(nested.lines.includes('(not extracted: unsupported format: image (PNG), no OCR)'));
  const ansi = await extract(fxPath('msg-ansi.msg'));
  assert.ok(ansi.lines.includes('To: xmailuser2@xmailserver.test'));
  const cjk = await extract(fxPath('msg-cjk.msg'));
  assert.ok(cjk.lines.includes('C 你好') && cjk.lines.includes('K 안녕하세요'));
});

test('EML body: text/plain when the message has one, else its HTML; without postal-mime\'s textTypes, the HTML when there is one', () => {
  const email = { text: 'plain text', html: '<p>html <b>text</b></p>' };
  assert.equal(emlBody(email, { textTypes: new Set(['plain', 'html']) }), 'plain text');
  assert.equal(emlBody(email, { textTypes: new Set(['html']) }), 'html text');
  // A parser without textTypes (or with something else there): the fallback.
  for (const parser of [{}, { textTypes: ['plain'] }, null]) {
    assert.equal(emlBody(email, parser), 'html text');
    assert.equal(emlBody({ text: 'only text' }, parser), 'only text');
  }
  assert.equal(emlBody({}, {}), '');
});

test('MSG body: plain, else HTML, else the compressed RTF through the RTF decoder', () => {
  const require = createRequire(import.meta.url);
  const m = require('@kenjiuno/msgreader');
  const MsgReader = m.default ?? m;
  const buf = fx('msg-simple.msg');
  const d = new MsgReader(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)).getFileData();
  assert.equal(msgBody(d), 'Simple\r\n');
  assert.equal(msgBody({ bodyHtml: '<html><head><title>T</title></head><body><p>From HTML</p></body></html>' }), 'From HTML');
  assert.ok(d.compressedRtf.length > 0);
  assert.match(msgBody({ compressedRtf: d.compressedRtf }), /^Simple/);
});
