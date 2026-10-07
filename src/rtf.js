// RTF → plain text. Code page from \ansicpgN, overridden per font by \fcharsetN from
// the font table; \'hh bytes are decoded by code page; \uN skips \ucN fallback
// characters. Non-text destinations are skipped; \cell → " | ", \row → new line;
// footnotes go to a trailing section.
import { DoclinesError } from './errors.js';
import { decoderForLabel } from './windows-1252.js';
import { LEGACY_DECODERS } from './html.js';

const CHARSET_CP = {
  0: 1252, 77: 10000, 128: 932, 129: 949, 134: 936, 136: 950, 161: 1253, 162: 1254, 163: 1258,
  177: 1255, 178: 1256, 186: 1257, 204: 1251, 222: 874, 238: 1250,
};

function cpLabel(cp) {
  if (cp >= 1250 && cp <= 1258) return `windows-${cp}`;
  return { 874: 'windows-874', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 866: 'ibm866', 10000: 'macintosh', 20866: 'koi8-r', 65001: 'utf-8' }[cp] ?? 'windows-1252';
}

// Destinations whose text is never document content.
const SKIP_DEST = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'themedata', 'datastore', 'latentstyles',
  'listtable', 'listoverridetable', 'revtbl', 'rsidtbl', 'filetbl', 'xmlnstbl', 'generator', 'fldinst',
  'nonshppict', 'bkmkstart', 'bkmkend', 'xe', 'tc', 'private',
]);
const SYMBOLS = {
  emdash: '—', endash: '–', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”',
  bullet: '•', emspace: ' ', enspace: ' ', qmspace: ' ', tab: '\t',
};

class Out {
  constructor() {
    this.lines = [];
    this.cur = '';
    this.cells = [];
  }

  inRow(intbl) {
    return intbl || this.cells.length > 0;
  }

  par(intbl) {
    if (this.inRow(intbl)) this.cur += ' ';
    else {
      this.lines.push(this.cur);
      this.cur = '';
    }
  }

  cell() {
    this.cells.push(this.cur.replace(/\s+/g, ' ').trim());
    this.cur = '';
  }

  row() {
    if (this.cur.trim() !== '') this.cell();
    if (this.cells.length) this.lines.push(this.cells.join(' | '));
    this.cells = [];
    this.cur = '';
  }

  end() {
    if (this.cells.length) this.row();
    if (this.cur !== '') this.lines.push(this.cur);
    return this.lines.join('\n');
  }
}

/** Returns { body, footnotes } as plain text. */
export function rtfToText(buf, name = 'input') {
  const s = buf.toString('latin1');
  const n = s.length;
  const fonts = new Map(); // font number → code page
  let docCp = 1252;
  let deff = null;
  let st = { skip: false, uc: 1, font: null, fonttbl: false, foot: false, hidden: false, star: false };
  const stack = [];
  const body = new Out();
  const foot = new Out();
  const out = () => (st.foot ? foot : body);
  let intbl = false;
  let skipN = 0;
  let fontDef = null;
  const decoders = new Map();
  let bytes = [];
  let bytesCp = null;

  const cpNow = () => {
    const f = st.font ?? deff;
    return (f !== null && fonts.get(f)) || docCp;
  };
  const decoder = (cp) => {
    if (!decoders.has(cp)) {
      const label = cpLabel(cp);
      if (!LEGACY_DECODERS && label !== 'utf-8') {
        throw new DoclinesError('unsupported', `code page ${cp} is not available in this Node build (it needs full ICU) (${name})`, { reason: 'charset not available' });
      }
      decoders.set(cp, decoderForLabel(label));
    }
    return decoders.get(cp);
  };
  const flush = () => {
    if (bytes.length) out().cur += decoder(bytesCp).decode(Uint8Array.from(bytes));
    bytes = [];
  };
  const visible = () => !st.skip && !st.fonttbl && !st.hidden;
  const pushByte = (b) => {
    if (skipN > 0) {
      skipN--;
      return;
    }
    if (!visible()) return;
    const cp = cpNow();
    if (bytes.length && cp !== bytesCp) flush();
    bytesCp = cp;
    bytes.push(b);
  };
  const emit = (text) => {
    flush();
    out().cur += text;
  };

  const word = (w, param) => {
    if (st.star) {
      st.star = false;
      if (w !== 'ud') st.skip = true;
    }
    if (w === 'ud') {
      st.skip = false;
      return;
    }
    if (w === 'bin') return 'bin';
    if (st.skip) return;
    if (st.fonttbl) {
      if (w === 'f') {
        fontDef = param;
        if (!fonts.has(param)) fonts.set(param, null);
      } else if (w === 'fcharset' && fontDef !== null && param in CHARSET_CP) fonts.set(fontDef, CHARSET_CP[param]);
      else if (w === 'cpg' && fontDef !== null && param) fonts.set(fontDef, param);
      return;
    }
    if (SKIP_DEST.has(w)) {
      if (w === 'fonttbl') st.fonttbl = true;
      else st.skip = true;
      return;
    }
    switch (w) {
      case 'ansi':
        docCp = 1252;
        return;
      case 'mac':
        docCp = 10000;
        return;
      case 'ansicpg':
        if (param) docCp = param;
        return;
      case 'deff':
        deff = param;
        return;
      case 'f':
        st.font = param;
        return;
      case 'plain':
        st.font = null;
        st.hidden = false;
        return;
      case 'v':
        st.hidden = param !== 0;
        return;
      case 'uc':
        st.uc = param ?? 1;
        return;
      case 'upr':
        // {\upr {ANSI text}{\*\ud {Unicode text}}}: only the \ud part is kept.
        st.skip = true;
        return;
      case 'u': {
        const cp = param < 0 ? param + 65536 : param;
        if (visible()) emit(String.fromCharCode(cp));
        skipN = st.uc;
        return 'u';
      }
      case 'footnote':
        flush();
        st.foot = true;
        return;
      case 'par':
      case 'line':
      case 'sect':
      case 'page':
        if (visible()) {
          flush();
          out().par(intbl);
        }
        return;
      case 'pard':
        intbl = false;
        return;
      case 'intbl':
        intbl = true;
        return;
      case 'cell':
      case 'nestcell':
        if (!st.skip) {
          flush();
          if (w === 'cell') out().cell();
          else out().cur += ' | ';
        }
        return;
      case 'row':
        if (!st.skip) {
          flush();
          out().row();
        }
        intbl = false;
        return;
      default:
        if (Object.hasOwn(SYMBOLS, w) && visible()) emit(SYMBOLS[w]);
    }
  };

  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === '{') {
      flush();
      stack.push(st);
      st = { ...st, star: false };
      skipN = 0;
      i++;
    } else if (c === '}') {
      flush();
      const wasFoot = st.foot;
      st = stack.pop() ?? st;
      if (wasFoot && !st.foot) foot.par(false);
      skipN = 0;
      i++;
    } else if (c === '\\') {
      const d = s[i + 1];
      if (d === undefined) break;
      if ((d >= 'a' && d <= 'z') || (d >= 'A' && d <= 'Z')) {
        let j = i + 1;
        while (j < n && j - i <= 32 && /[a-zA-Z]/.test(s[j])) j++;
        const w = s.slice(i + 1, j);
        let k = j;
        if (s[k] === '-') k++;
        while (k < n && k - j <= 11 && s[k] >= '0' && s[k] <= '9') k++;
        const digits = s.slice(j, k);
        const param = /\d/.test(digits) ? Number(digits) : null;
        if (s[k] === ' ') k++;
        i = k;
        flush();
        const r = word(w, param);
        if (r === 'bin') {
          flush();
          i += Math.max(0, param ?? 0);
        }
        if (r !== 'u') skipN = 0;
      } else if (d === "'") {
        const h = parseInt(s.slice(i + 2, i + 4), 16);
        i += 4;
        if (!Number.isNaN(h)) pushByte(h);
      } else {
        i += 2;
        if (d === '*') st.star = true;
        else if (d === '\\' || d === '{' || d === '}') pushByte(d.charCodeAt(0));
        else if (d === '~') {
          if (visible()) emit('\u00a0');
        } else if (d === '_') {
          if (visible()) emit('‑');
        } else if (d === '\n' || d === '\r') {
          if (visible()) {
            flush();
            out().par(intbl);
          }
        }
        // \- (optional hyphen), \: and \| carry no text.
      }
    } else if (c === '\n' || c === '\r') {
      i++;
    } else {
      if (st.star) st.skip = true;
      pushByte(s.charCodeAt(i));
      i++;
    }
  }
  flush();
  return { body: body.end(), footnotes: foot.end() };
}
