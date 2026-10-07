// Format detection by content; the extension only breaks ties (HTML, encrypted OOXML).
// `sniff` looks at the first bytes; `classify` looks inside ZIP and OLE containers:
// their directories, stream heads and the container metadata entries (zip.js
// META_ENTRIES), nothing else.
import path from 'node:path';
import { ContainerError, isOle, isZip, readOle } from './containers.js';
import { DoclinesError } from './errors.js';
import { NS, attr, child, decodeXml, findAll, parseXml } from './xml.js';
import { Zip, ZipError } from './zip.js';

export const SNIFF_BYTES = 8192;
const HTML_EXT = new Set(['.htm', '.html', '.xhtml']);
// Content types that make a fetched body HTML, as the extension .html does.
export const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);

const f = (id, label, family, extensions, textOnDisk = false) => Object.freeze({ id, label, family, extensions: Object.freeze(extensions), textOnDisk });

/** Every format id: { id, label, family, extensions, textOnDisk }. */
export const FORMATS = Object.freeze([
  f('text', 'plain text', 'text', ['.txt', '.md', '.csv', '.log'], true),
  f('html', 'HTML page (.html)', 'document', ['.html', '.htm', '.xhtml'], true),
  f('pdf', 'PDF document (.pdf)', 'document', ['.pdf']),
  f('docx', 'Word document (.docx)', 'document', ['.docx', '.docm', '.dotx', '.dotm']),
  f('doc', 'Word document (.doc)', 'document', ['.doc']),
  f('rtf', 'RTF document (.rtf)', 'document', ['.rtf'], true),
  f('xlsx', 'Excel workbook (.xlsx)', 'spreadsheet', ['.xlsx', '.xlsm', '.xltx', '.xltm']),
  f('xls', 'Excel workbook (.xls)', 'spreadsheet', ['.xls']),
  f('ods', 'OpenDocument spreadsheet (.ods)', 'spreadsheet', ['.ods']),
  f('pptx', 'PowerPoint presentation (.pptx)', 'presentation', ['.pptx', '.pptm', '.potx', '.potm', '.ppsx']),
  f('ppt', 'PowerPoint presentation (.ppt)', 'presentation', ['.ppt']),
  f('odt', 'OpenDocument text (.odt)', 'document', ['.odt', '.ott']),
  f('odp', 'OpenDocument presentation (.odp)', 'presentation', ['.odp', '.otp']),
  f('epub', 'EPUB book (.epub)', 'book', ['.epub']),
  f('fb2', 'FictionBook (.fb2)', 'book', ['.fb2', '.fb2.zip'], true),
  f('eml', 'email message (.eml)', 'message', ['.eml'], true),
  f('msg', 'Outlook message (.msg)', 'message', ['.msg']),
]);

export const FORMAT_BY_ID = new Map(FORMATS.map((x) => [x.id, x]));

// Formats with an extractor in this version.
export const EXTRACTED = new Set(['text', 'html', 'pdf', 'docx', 'doc', 'rtf', 'xlsx', 'xls', 'ods', 'pptx', 'ppt', 'odp', 'odt', 'epub', 'fb2', 'eml', 'msg']);

// Short names in "damaged or unsupported X file".
export const SHORT_NAME = {
  pdf: 'PDF',
  zip: 'DOCX',
  ole: 'DOC',
  docx: 'DOCX',
  doc: 'DOC',
  rtf: 'RTF',
  html: 'HTML',
  xlsx: 'XLSX',
  xls: 'XLS',
  ods: 'ODS',
  pptx: 'PPTX',
  ppt: 'PPT',
  odt: 'ODT',
  odp: 'ODP',
  epub: 'EPUB',
  fb2: 'FB2',
  eml: 'EML',
  msg: 'MSG',
};

const labelOf = (format) => (format ? FORMAT_BY_ID.get(format).label : null);

export function unsupported(label, name, { format = null, code = 'unsupported' } = {}) {
  return new DoclinesError(code, `unsupported format: ${label} (${name})`, { format, label, reason: `unsupported format: ${label}` });
}

export function encrypted(name, format = null) {
  return new DoclinesError('encrypted', `encrypted document: password-protected files are not read (${name})`, {
    format,
    label: labelOf(format),
    reason: 'encrypted document',
  });
}

/** A damaged file of a known kind: the internal detail goes to `detail`, never the message. */
export function damagedFile(name, kindOrFormat, detail) {
  const format = FORMAT_BY_ID.has(kindOrFormat) ? kindOrFormat : null;
  return new DoclinesError('damaged', `cannot read ${name}: damaged or unsupported ${SHORT_NAME[kindOrFormat] ?? kindOrFormat} file`, {
    format,
    label: labelOf(format),
    reason: 'damaged or unsupported file',
    detail: detail ?? undefined,
  });
}

/** A ZipError (zip.js) as the refusal of a `format` file. */
export function fromZipError(e, name, format) {
  if (e.code === 'encrypted') return encrypted(name, format);
  if (e.code === 'too_large') {
    return new DoclinesError('too_large', `document too large: ${name} (unpacked ${e.message})`, { format, label: labelOf(format), reason: 'document too large' });
  }
  return damagedFile(name, format ?? 'zip', e.message);
}

// A leading <!doctype html> or <html>, after whitespace, comments and an XML
// declaration, within the first 1 KB.
export function looksLikeHtml(head) {
  return /^<!doctype\s+html|^<html[\s>]/i.test(afterProlog(head));
}

function afterProlog(head) {
  let s = head.subarray(0, 1024).toString('latin1').replace(/^\xef\xbb\xbf/, '');
  for (;;) {
    s = s.replace(/^\s+/, '');
    if (s.startsWith('<!--')) {
      const end = s.indexOf('-->');
      if (end < 0) return '';
      s = s.slice(end + 3);
    } else if (s.startsWith('<?xml')) {
      const end = s.indexOf('?>');
      if (end < 0) return '';
      s = s.slice(end + 2);
    } else return s;
  }
}

// A FictionBook document: its root element after the prolog.
export function looksLikeFb2(head) {
  return /^<(?:[\w.-]+:)?FictionBook[\s>/]/.test(afterProlog(head));
}

const ascii = (head, off, s) => head.length >= off + s.length && head.toString('latin1', off, off + s.length) === s;
const bytes = (head, off, arr) => head.length >= off + arr.length && arr.every((b, i) => head[off + i] === b);
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);

/** The label of a recognised binary format that is not read, from its signature, or null. */
export function binaryLabel(head) {
  if (bytes(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image (PNG), no OCR';
  if (bytes(head, 0, [0xff, 0xd8, 0xff])) return 'image (JPEG), no OCR';
  if (ascii(head, 0, 'GIF87a') || ascii(head, 0, 'GIF89a')) return 'image (GIF), no OCR';
  if (ascii(head, 0, 'RIFF') && ascii(head, 8, 'WEBP')) return 'image (WebP), no OCR';
  if (bytes(head, 0, [0x49, 0x49, 0x2a, 0x00]) || bytes(head, 0, [0x4d, 0x4d, 0x00, 0x2a])) return 'image (TIFF), no OCR';
  // "BM", file size, two reserved zero words, pixel data offset.
  if (ascii(head, 0, 'BM') && head.length >= 14 && head.readUInt32LE(6) === 0 && head.readUInt32LE(10) >= 26) return 'image (BMP), no OCR';
  if (ascii(head, 4, 'ftyp') && head.length >= 12 && HEIF_BRANDS.has(head.toString('latin1', 8, 12))) return 'image (HEIC), no OCR';
  if (ascii(head, 0, 'AT&TFORM')) return 'DjVu document';
  if (bytes(head, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7z archive';
  if (ascii(head, 0, 'Rar!\x1a\x07')) return 'RAR archive';
  if (bytes(head, 0, [0x1f, 0x8b, 0x08])) return 'gzip archive';
  if (ascii(head, 0, 'BZh') && head[3] >= 0x31 && head[3] <= 0x39 && (bytes(head, 4, [0x31, 0x41, 0x59, 0x26, 0x53, 0x59]) || bytes(head, 4, [0x17, 0x72, 0x45, 0x38, 0x50, 0x90]))) {
    return 'bzip2 archive';
  }
  if (bytes(head, 0, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return 'xz archive';
  if (ascii(head, 257, 'ustar') && (head[262] === 0 || head[262] === 0x20)) return 'tar archive';
  if (ascii(head, 0, 'SQLite format 3\0')) return 'SQLite database';
  return null;
}

/** 'pdf' | 'zip' | 'ole' | 'binary' | 'rtf' | 'fb2' | 'html' | 'text' from the first bytes and the extension. */
export function sniff(head, ext = '') {
  // "%PDF-" at offset 0; junk before it (within the first 1 KB) only for a .pdf file.
  if (head.toString('latin1', 0, 5) === '%PDF-') return 'pdf';
  if (ext.toLowerCase() === '.pdf' && head.subarray(0, 1024).includes('%PDF-')) return 'pdf';
  if (isZip(head)) return 'zip';
  if (isOle(head)) return 'ole';
  if (binaryLabel(head)) return 'binary';
  const start = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
  if (head.toString('latin1', start, start + 5) === '{\\rtf') return 'rtf';
  if (looksLikeFb2(head)) return 'fb2';
  if (HTML_EXT.has(ext.toLowerCase()) || looksLikeHtml(head)) return 'html';
  return 'text';
}

const ODF = {
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.text-template': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.spreadsheet-template': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/vnd.oasis.opendocument.presentation-template': 'odp',
  'application/epub+zip': 'epub',
};
const ODF_REFUSED = {
  'application/vnd.oasis.opendocument.graphics': 'OpenDocument drawing (.odg)',
  'application/vnd.oasis.opendocument.graphics-template': 'OpenDocument drawing (.odg)',
};

// Encrypted OOXML hides its type inside the encrypted package: the extension names it.
function ooxmlByExt(ext) {
  const e = ext.toLowerCase();
  for (const id of ['docx', 'xlsx', 'pptx']) if (FORMAT_BY_ID.get(id).extensions.includes(e)) return id;
  return null;
}

// EPUB font obfuscation (EPUB 3.3 §4.4, and Adobe's older scheme): fonts only.
const FONT_OBFUSCATION = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']);
const FONT_FILE = /\.(?:otf|ttf|woff2?|eot)$/i;

// A metadata entry as XML, or null when it is missing; `onError` for an unreadable one.
function metaXml(zip, entry, { ci = false, onError = () => null } = {}) {
  let buf;
  try {
    buf = zip.readMeta(entry, { ci });
  } catch (e) {
    if (e instanceof ZipError) return onError(e);
    throw e;
  }
  return buf ? parseXml(decodeXml(buf).text) : null;
}

/** EPUB META-INF/encryption.xml → [{ algorithm, path }], paths from the container root. */
export function epubEncryptionList(doc) {
  return findAll(doc, NS.xmlenc, 'EncryptedData').map((data) => {
    const uri = (attr(findAll(data, NS.xmlenc, 'CipherReference')[0], '', 'URI') ?? '').split(/[?#]/)[0];
    let p = uri;
    try {
      p = decodeURIComponent(uri);
    } catch {
      // Not percent-encoded as it should be: used as written.
    }
    return { algorithm: attr(child(data, NS.xmlenc, 'EncryptionMethod'), '', 'Algorithm'), path: path.posix.normalize(p.replace(/^\/+/, '')) };
  });
}

const obfuscatedFont = (e) => FONT_OBFUSCATION.has(e.algorithm) && FONT_FILE.test(e.path);

/**
 * EPUB, calling thread: true when encryption.xml lists anything but obfuscated fonts.
 * An encryption.xml it may not inflate (over 1 MB) is left to the worker.
 */
export function epubEncrypted(zip) {
  return epubEncryptionList(metaXml(zip, 'META-INF/encryption.xml')).some((e) => !obfuscatedFont(e));
}

/**
 * EPUB, worker: encryption.xml read under the ZIP caps; true when it lists anything but
 * obfuscated fonts, or any spine item (`spine`: Set of paths) whatever the algorithm.
 */
export function epubEncryptedFull(zip, spine) {
  const buf = zip.read('META-INF/encryption.xml');
  return epubEncryptionList(buf ? parseXml(decodeXml(buf).text) : null).some((e) => !obfuscatedFont(e) || spine.has(e.path));
}

const manifestEncrypted = (doc) => findAll(doc, NS.manifest, 'encryption-data').length > 0;

/**
 * ODF, calling thread: true when META-INF/manifest.xml has <manifest:encryption-data>.
 * A manifest it may not inflate (over 1 MB) is left to the worker.
 */
export function odfEncrypted(zip) {
  return manifestEncrypted(metaXml(zip, 'META-INF/manifest.xml'));
}

/** ODF, worker: the manifest read under the ZIP caps. */
export function odfEncryptedFull(zip) {
  const buf = zip.read('META-INF/manifest.xml');
  return manifestEncrypted(buf ? parseXml(decodeXml(buf).text) : null);
}

function odfRootType(zip) {
  const doc = metaXml(zip, 'META-INF/manifest.xml');
  for (const e of findAll(doc, NS.manifest, 'file-entry')) if (attr(e, NS.manifest, 'full-path') === '/') return attr(e, NS.manifest, 'media-type');
  return null;
}

/** OOXML: { target, contentType } of the officeDocument relationship, or null. */
export function ooxmlMain(zip) {
  const rels = metaXml(zip, '_rels/.rels', { ci: true });
  const rel = findAll(rels, NS.rel, 'Relationship').find((r) => /\/officeDocument$/.test(attr(r, '', 'Type') ?? ''));
  if (!rel) return null;
  const target = (attr(rel, '', 'Target') ?? '').replace(/^\//, '');
  const types = metaXml(zip, '[Content_Types].xml', { ci: true });
  const over = findAll(types, NS.ct, 'Override').find((o) => (attr(o, '', 'PartName') ?? '').replace(/^\//, '').toLowerCase() === target.toLowerCase());
  return { target, contentType: attr(over, '', 'ContentType') };
}

function ooxmlFormat(main, zip) {
  const ct = main?.contentType ?? '';
  if (ct.includes('ms-excel.sheet.binary')) return 'xlsb';
  if (ct.includes('wordprocessingml') || ct.includes('ms-word')) return 'docx';
  if (ct.includes('spreadsheetml') || ct.includes('ms-excel')) return 'xlsx';
  if (ct.includes('presentationml') || ct.includes('ms-powerpoint')) return 'pptx';
  const t = (main?.target ?? '').toLowerCase();
  if (t.startsWith('xl/') && t.endsWith('.bin')) return 'xlsb';
  if (t.startsWith('word/')) return 'docx';
  if (t.startsWith('xl/')) return 'xlsx';
  if (t.startsWith('ppt/')) return 'pptx';
  if (zip.has('word/document.xml', { ci: true })) return 'docx';
  if (zip.has('xl/workbook.bin', { ci: true })) return 'xlsb';
  if (zip.has('xl/workbook.xml', { ci: true })) return 'xlsx';
  if (zip.names.some((n) => n.toLowerCase().startsWith('ppt/'))) return 'pptx';
  return null;
}

function classifyZip(buf, name, maxDocBytes) {
  let zip;
  try {
    zip = new Zip(buf, { maxDocBytes });
  } catch (e) {
    if (e instanceof ZipError) throw fromZipError(e, name, null);
    throw e;
  }
  const found = (format) => {
    if (zip.truncated) throw damagedFile(name, format, 'ZIP archive without a central directory');
    return format;
  };
  let mime = null;
  if (zip.has('mimetype')) {
    try {
      mime = zip.readMeta('mimetype')?.toString('latin1').trim() || null;
    } catch (e) {
      if (!(e instanceof ZipError)) throw e;
    }
  }
  if (mime) {
    const format = ODF[mime];
    if (!format) {
      throw unsupported(ODF_REFUSED[mime] ?? (mime.startsWith('application/vnd.oasis.opendocument') ? 'OpenDocument file' : `ZIP archive (${mime})`), name);
    }
    found(format);
    if (format === 'epub' ? epubEncrypted(zip) : odfEncrypted(zip)) throw encrypted(name, format);
    return format;
  }
  if (zip.has('META-INF/container.xml') && !zip.has('content.xml')) {
    found('epub');
    if (epubEncrypted(zip)) throw encrypted(name, 'epub');
    return 'epub';
  }
  if (zip.has('content.xml') && zip.has('META-INF/manifest.xml')) {
    const format = ODF[odfRootType(zip)];
    if (!format) throw unsupported('OpenDocument file', name);
    found(format);
    if (odfEncrypted(zip)) throw encrypted(name, format);
    return format;
  }
  if (zip.has('FixedDocumentSequence.fdseq', { ci: true }) || zip.has('FixedDocSeq.fdseq', { ci: true })) throw unsupported('XPS document (.xps, .oxps)', name);
  if (zip.has('Index/Document.iwa')) throw unsupported('Apple iWork document (.pages, .numbers, .key)', name);
  const ooxml = ooxmlFormat(ooxmlMain(zip), zip);
  if (ooxml === 'xlsb') throw unsupported('Excel binary workbook (.xlsb)', name);
  if (ooxml) return found(ooxml);
  const files = zip.names.filter((n) => !n.endsWith('/'));
  if (files.length === 1 && /\.fb2$/i.test(files[0])) return found('fb2');
  throw unsupported('ZIP archive', name);
}

const WORD97_IDENT = 0xa5ec;
const F_ENCRYPTED = 0x0100;
// [MS-XLS] records: BOF, FilePass, WriteProtect.
const BIFF_BOF = 0x0809;
const BIFF8 = 0x0600;
const FILEPASS = 0x002f;
const WRITEPROTECT = 0x0086;
// [MS-PPT] CurrentUserAtom: record type, docFileVersion and majorVersion of PowerPoint 97
// and later, headerToken of an encrypted file.
const CURRENT_USER_ATOM = 0x0ff6;
const PPT_DOC_FILE_VERSION = 0x03f4;
const PPT_ENCRYPTED_TOKEN = 0xf3d1c4df;

/**
 * 'xls' | 'older' | 'encrypted' | 'damaged' from the first bytes of a Workbook stream:
 * BOF (type 0x0809, then the BIFF version, 0x0600 for Excel 97 and later); FilePass,
 * when present, follows BOF, at most after WriteProtect ([MS-XLS] 2.1.7.20.3).
 */
export function workbookState(head) {
  if (!head || head.length < 8 || head.readUInt16LE(0) !== BIFF_BOF) return 'damaged';
  if (head.readUInt16LE(4) !== BIFF8) return 'older';
  for (let p = 4 + head.readUInt16LE(2), k = 0; k < 2 && p + 4 <= head.length; k++) {
    const type = head.readUInt16LE(p);
    if (type === FILEPASS) return 'encrypted';
    if (type !== WRITEPROTECT) break;
    p += 4 + head.readUInt16LE(p + 2);
  }
  return 'xls';
}

/**
 * 'ppt' | 'older' | 'encrypted' from the first bytes of a Current User stream: a
 * PowerPoint 97+ CurrentUserAtom has docFileVersion 0x03F4 and majorVersion 3, and
 * headerToken 0xF3D1C4DF when the file is encrypted ([MS-PPT] 2.3.2).
 */
export function currentUserState(cu) {
  if (!cu || cu.length < 26 || cu.readUInt16LE(2) !== CURRENT_USER_ATOM || cu.readUInt16LE(22) !== PPT_DOC_FILE_VERSION || cu[24] !== 3) return 'older';
  return cu.readUInt32LE(12) === PPT_ENCRYPTED_TOKEN ? 'encrypted' : 'ppt';
}

/**
 * Final format id of a file of `kind`, or a refusal (DoclinesError) naming the format.
 * Encryption is checked before the Word/Excel streams: a password-protected
 * DOCX/XLSX is an OLE file with EncryptionInfo + EncryptedPackage (MS-OFFCRYPTO);
 * a protected DOC keeps WordDocument with fEncrypted set in its FibBase.
 */
export function classify(buf, kind, name, ext = '', { maxDocBytes = 52428800 } = {}) {
  if (kind === 'binary') throw unsupported(binaryLabel(buf), name);
  if (kind === 'zip') return classifyZip(buf, name, maxDocBytes);
  if (kind === 'ole') {
    let ole;
    try {
      ole = readOle(buf);
    } catch (e) {
      if (e instanceof ContainerError) throw unsupported('damaged OLE compound file', name, { code: 'damaged' });
      throw e;
    }
    if (ole.names.has('ENCRYPTEDPACKAGE')) throw encrypted(name, ooxmlByExt(ext));
    if (ole.names.has('WORDDOCUMENT')) {
      const fib = ole.head('WordDocument', 12);
      if (!fib || fib.length < 12) throw unsupported('damaged Word document (.doc)', name, { format: 'doc', code: 'damaged' });
      if (fib.readUInt16LE(0) !== WORD97_IDENT) throw unsupported('Word document older than Word 97 (.doc)', name);
      if (fib.readUInt16LE(0x0a) & F_ENCRYPTED) throw encrypted(name, 'doc');
      return 'doc';
    }
    if (ole.names.has('WORKBOOK')) {
      const state = workbookState(ole.head('Workbook', 64));
      if (state === 'damaged') throw damagedFile(name, 'xls', 'Workbook stream without a BOF record');
      if (state === 'older') throw unsupported('Excel workbook older than Excel 97 (.xls)', name);
      if (state === 'encrypted') throw encrypted(name, 'xls');
      return 'xls';
    }
    if (ole.names.has('BOOK')) throw unsupported('Excel workbook older than Excel 97 (.xls)', name);
    if (ole.names.has('POWERPOINT DOCUMENT')) {
      const state = currentUserState(ole.head('Current User', 28));
      if (state === 'older') throw unsupported('PowerPoint presentation older than PowerPoint 97 (.ppt)', name);
      if (state === 'encrypted') throw encrypted(name, 'ppt');
      return 'ppt';
    }
    if (ole.names.has('PP40')) throw unsupported('PowerPoint presentation older than PowerPoint 97 (.ppt)', name);
    // An Outlook item: a property stream and named property streams ([MS-OXMSG] 2.4).
    if (ole.names.has('__PROPERTIES_VERSION1.0') && [...ole.names].some((n) => n.startsWith('__SUBSTG1.0_'))) return 'msg';
    throw unsupported('OLE compound file', name);
  }
  return kind;
}
