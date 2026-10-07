// Shared by the spreadsheet and table extractors: cell values, row lines, dates.

// A run of more empty cells than this between two values collapses to one "…".
export const MAX_EMPTY_RUN = 64;
// A non-empty repeated row or cell (ODF) is written out at most this many times.
export const MAX_REPEAT = 1000;

/** A cell value as one line: line breaks → space, surrounding whitespace trimmed. */
export function cellText(s) {
  return String(s ?? '')
    .replace(/\r\n|[\r\n\v\f\u2028\u2029]/g, ' ')
    .trim();
}

/**
 * Cells (Map or array, 0-based column → text) → "v1 | v2 | …" from column A: empty
 * cells between values kept as empty slots, a run of more than MAX_EMPTY_RUN of them
 * collapsed to one "…" (reported through `onCollapse(count)`), trailing empty cells
 * dropped. null when no cell has text.
 */
export function joinCells(cells, onCollapse = () => {}) {
  const get = cells instanceof Map ? (i) => cells.get(i) : (i) => cells[i];
  let last = -1;
  for (const [i, v] of cells instanceof Map ? cells : cells.entries()) if (v && i > last) last = i;
  if (last < 0) return null;
  const parts = [];
  let gap = 0;
  for (let i = 0; i <= last; i++) {
    const v = get(i);
    if (!v) {
      gap++;
      continue;
    }
    if (gap > MAX_EMPTY_RUN) {
      parts.push('…');
      onCollapse(gap);
    } else for (let k = 0; k < gap; k++) parts.push('');
    gap = 0;
    parts.push(v);
  }
  return parts.join(' | ');
}

/** Number as stored, in the shortest form that reads back the same value. */
export function numberText(v) {
  const n = Number(v);
  return Number.isFinite(n) && String(v).trim() !== '' ? String(n) : String(v);
}

/** "A" → 0, "BZ" → 77; the column of a cell reference like "BZ8". */
export function columnIndex(ref) {
  const m = /^\$?([A-Za-z]{1,3})/.exec(ref ?? '');
  if (!m) return null;
  let n = 0;
  for (const c of m[1].toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

/** "B7" → 7 */
export function rowIndex(ref) {
  const m = /^\$?[A-Za-z]{1,3}\$?(\d+)$/.exec(ref ?? '');
  return m ? Number(m[1]) : null;
}

// ---- dates (ECMA-376 Part 1 §18.8.30, §18.17.4) ----

// Built-in number formats with an implied date or time code. 27–36 and 50–58 are East
// Asian formats whose meaning depends on the UI language: date or time by the value.
const BUILTIN = {
  14: 'date', 15: 'date', 16: 'date', 17: 'date',
  18: 'time', 19: 'time', 20: 'time', 21: 'time',
  22: 'datetime',
  45: 'time', 46: 'elapsed', 47: 'time',
};
for (const id of [27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58]) BUILTIN[id] = 'auto';

/**
 * 'date' | 'time' | 'datetime' | 'elapsed' | 'auto' | null for a number format: the
 * custom `code` when given, else the built-in id. A code is a date/time code when it has
 * y, m, d, h or s outside quoted text, escapes and [...]; a code with an elapsed-time part
 * ([h], [mm], [ss], any case and length) is 'elapsed': a duration, as built-in 46.
 */
export function dateKind(numFmtId, code) {
  if (code == null) return BUILTIN[numFmtId] ?? null;
  if (/\[(?:h+|m+|s+)\]/i.test(code)) return 'elapsed';
  const s = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/[_*]./g, '')
    .replace(/\[[^\]]*\]/g, '');
  const ampm = /AM\/PM|A\/P/i.test(s);
  const t = s.replace(/AM\/PM|A\/P/gi, '');
  const h = /h/i.test(t);
  const sec = /s/i.test(t);
  const date = /[yd]/i.test(t) || (/m/i.test(t) && !h && !sec);
  const time = h || sec || ampm;
  if (date && time) return 'datetime';
  if (date) return 'date';
  if (time) return 'time';
  return null;
}

const DAY = 86400000;
const pad = (n, w = 2) => String(n).padStart(w, '0');

function isoDate(days, date1904) {
  if (date1904) return new Date(Date.UTC(1904, 0, 1) + days * DAY).toISOString().slice(0, 10);
  // 1900 system: serial 60 is the 29 February 1900 that never was (Lotus 1-2-3).
  if (days === 60) return '1900-02-29';
  const base = days < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  return new Date(base + days * DAY).toISOString().slice(0, 10);
}

function clock(secs) {
  return `${pad(Math.floor(secs / 3600) % 24)}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}`;
}

/** An Excel serial date/time → ISO text by `kind` (dateKind), or null when not a date. */
export function serialText(serial, kind, date1904 = false) {
  if (!kind || !Number.isFinite(serial) || serial < 0) return null;
  let days = Math.floor(serial);
  let secs = Math.round((serial - days) * 86400);
  if (kind === 'elapsed') {
    const total = Math.round(serial * 86400);
    return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
  }
  if (secs === 86400) {
    days += 1;
    secs = 0;
  }
  if (kind === 'auto') kind = secs === 0 ? 'date' : days === 0 ? 'time' : 'datetime';
  if (kind === 'time') return clock(secs);
  if (kind === 'date') return isoDate(days, date1904);
  return `${isoDate(days, date1904)} ${clock(secs)}`;
}

/** ODF office:date-value (xsd:date or xsd:dateTime) → "YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS". */
export function odfDateText(v) {
  const m = /^(-?\d{4,}-\d{2}-\d{2})(?:T(\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?)?/.exec(v ?? '');
  if (!m) return v ?? '';
  if (!m[2]) return m[1];
  return `${m[1]} ${m[2].length === 5 ? `${m[2]}:00` : m[2]}`;
}

/** ODF office:time-value (xsd:duration, "PT36H00M00S") → "HH:MM:SS"; hours may exceed 24. */
export function odfDurationText(v) {
  const m = /^(-)?P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(v ?? '');
  if (!m) return v ?? '';
  const total = Math.round((Number(m[2] ?? 0) * 24 + Number(m[3] ?? 0)) * 3600 + Number(m[4] ?? 0) * 60 + Number(m[5] ?? 0));
  return `${m[1] ?? ''}${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
}
