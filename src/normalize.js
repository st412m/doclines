// Text normalisation for extracted formats (plain text files stay byte-exact).
// No homoglyph folding: a Latin letter inside a Cyrillic word stays as it is.

export function normalizeText(text) {
  return text
    .replace(/[\u00ad\u200b\ufeff\r]/g, '')
    .replace(/\u00a0/g, ' ')
    .normalize('NFC');
}

// A line ending with a soft hyphen (U+00AD) holds a word broken across lines (PDF):
// the first word of the next line moves up to it, without the hyphen; a next line
// left empty is dropped; repeated while the joined line still ends with U+00AD.
// Within one section only (toLines runs per section). A hard hyphen is never joined.
export function joinSoftHyphens(lines) {
  const rest = [...lines];
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    let line = rest[i];
    while (/\u00ad\s*$/.test(line) && i + 1 < rest.length) {
      const next = rest[i + 1].replace(/^\s+/, '');
      const word = /^\S*/.exec(next)[0];
      line = line.replace(/\u00ad\s*$/, '') + word;
      const left = next.slice(word.length).replace(/^\s+/, '');
      if (left !== '') {
        rest[i + 1] = left;
        break;
      }
      i++;
    }
    out.push(line);
  }
  return out;
}

// Extracted text → lines: words split by a soft hyphen at a line end joined,
// normalised, trailing whitespace trimmed, leading and trailing blank lines dropped,
// runs of blank lines collapsed to one.
export function toLines(text) {
  const out = [];
  for (const raw of joinSoftHyphens(text.replace(/\r/g, '').split('\n'))) {
    const line = normalizeText(raw).replace(/\s+$/, '');
    if (line === '' && (out.length === 0 || out.at(-1) === '')) continue;
    out.push(line);
  }
  while (out.length && out.at(-1) === '') out.pop();
  return out;
}

/**
 * Sections ([{ marker, page, kind, n, label, text }]) → { lines, markers, pageStarts,
 * sections }. A marker line (`--- page 12 ---`) is not a numbered line: it is kept as
 * { at, text }, placed before the 0-based line `at`. pageStarts[p - 1] = first line
 * number (1-based) of page p, or null when no section carries a page. A section with a
 * `kind` is listed as { kind, n, label, start, end } (1-based, end inclusive; empty:
 * end = start - 1). A section may hold `sections` of its own (an extracted attachment):
 * they follow its text and lie inside its range; their pages are not the document's.
 * Text over `maxTextBytes` (UTF-8 bytes of the lines plus one per line break) throws
 * `tooLarge()` as soon as it is exceeded.
 */
export function assemble(sections, { maxTextBytes = Infinity, tooLarge = null } = {}) {
  const lines = [];
  const markers = [];
  const listed = [];
  let pageStarts = null;
  let bytes = 0;
  const add = (list, nested) => {
    for (const s of list) {
      if (s.marker) markers.push({ at: lines.length, text: s.marker });
      if (s.page && !nested) {
        pageStarts ??= [];
        pageStarts[s.page - 1] = lines.length + 1;
      }
      const entry = s.kind ? { kind: s.kind, n: s.n ?? null, label: s.label ?? null, start: lines.length + 1, end: 0 } : null;
      if (entry) listed.push(entry);
      for (const l of toLines(s.text ?? '')) {
        bytes += Buffer.byteLength(l) + 1;
        if (bytes > maxTextBytes) throw tooLarge();
        lines.push(l);
      }
      if (s.sections) add(s.sections, true);
      if (entry) entry.end = lines.length;
    }
  };
  add(sections, false);
  return { lines, markers, pageStarts, sections: listed };
}

// The innermost section of `result` holding 1-based line n, or null: the one starting
// last, of those the shortest; of equal ranges the inner one (listed later).
export function sectionOf(result, n) {
  let best = null;
  for (const s of result?.sections ?? []) {
    if (n < s.start || n > s.end) continue;
    if (!best || s.start > best.start || (s.start === best.start && s.end <= best.end)) best = s;
  }
  return best;
}

// A name or title inside a marker: control characters removed, line breaks → space,
// at most 120 characters.
export function markerLabel(s) {
  return String(s ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, 120);
}

// Page of 1-based line n: the last page starting at or before it.
export function pageOf(pageStarts, n) {
  if (!pageStarts) return null;
  let lo = 0;
  let hi = pageStarts.length - 1;
  let found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pageStarts[mid] <= n) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found === null ? null : found + 1;
}

// [3, 7, 8, 9] → "3, 7–9"
export function pageRanges(nums) {
  const out = [];
  for (const n of nums) {
    const last = out.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');
}

// Checks compare at whitespace level: runs of whitespace (NBSP included) are one
// space, U+00AD does not count.
export function foldSpace(s) {
  return s.replace(/\u00ad/g, '').replace(/\s+/g, ' ').trim();
}
