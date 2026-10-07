// XLSX/XLSM/XLTX/XLTM (ECMA-376 Part 1 SpreadsheetML) → one section per sheet. Rows
// are "[R] v1 | v2 | …" with R the sheet row number; cells from column A. Shared and
// inline strings as text, numbers as stored, dates by number format, booleans
// TRUE/FALSE, errors as text, formulas by their cached value. Worksheets are read as a
// stream; the other parts as trees.
import { mainPart, readPart, relOfType, relsOf, xmlPart } from './opc.js';
import { markerLabel } from './normalize.js';
import { cellText, columnIndex, dateKind, joinCells, numberText, rowIndex, serialText } from './sheet.js';
import { NS, attr, decodeXml, findAll, kids, sax } from './xml.js';
import { Zip } from './zip.js';

const truthy = (v) => v === '1' || v === 'true';

// Shared strings: <si> text with rich runs concatenated, phonetic runs (<rPh>) skipped.
function sharedStrings(zip, part) {
  const buf = readPart(zip, part);
  if (!buf) return [];
  const out = [];
  let cur = null;
  let inT = 0;
  let skip = 0;
  sax(decodeXml(buf).text, {
    open(el) {
      if (!NS.sml.has(el.ns)) return;
      if (el.local === 'si') cur = '';
      else if (el.local === 'rPh') skip++;
      else if (el.local === 't') inT++;
    },
    close(el) {
      if (!NS.sml.has(el.ns)) return;
      if (el.local === 'si') {
        out.push(cur);
        cur = null;
      } else if (el.local === 'rPh') skip--;
      else if (el.local === 't') inT--;
    },
    text(s) {
      if (cur !== null && inT && !skip) cur += s;
    },
  });
  return out;
}

// Cell style index → date kind (dateKind), from cellXfs and the custom number formats.
function styleKinds(zip, part) {
  const doc = xmlPart(zip, part);
  const codes = new Map();
  for (const f of findAll(doc, NS.sml, 'numFmt')) codes.set(Number(attr(f, '', 'numFmtId')), attr(f, '', 'formatCode'));
  const xfs = findAll(doc, NS.sml, 'cellXfs')[0];
  return kids(xfs, NS.sml, 'xf').map((xf) => {
    const id = Number(attr(xf, '', 'numFmtId') ?? 0);
    return dateKind(id, codes.has(id) ? codes.get(id) : null);
  });
}

// Merged areas: every cell but the top-left one is left empty. The <mergeCells> list
// follows <sheetData>, so it is collected from the text before the stream starts.
function mergedCovered(text) {
  const covered = new Set();
  for (const m of text.matchAll(/<(?:[\w.-]+:)?mergeCell\b[^>]*?\bref="([A-Za-z]+\d+):([A-Za-z]+\d+)"/g)) {
    const c0 = columnIndex(m[1]);
    const r0 = rowIndex(m[1]);
    const c1 = columnIndex(m[2]);
    const r1 = rowIndex(m[2]);
    if ((r1 - r0 + 1) * (c1 - c0 + 1) > 1e6) continue;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (r !== r0 || c !== c0) covered.add(`${r}:${c}`);
  }
  return covered;
}

function sheetRows(text, { strings, kinds, date1904, ctx, sheetNo }) {
  const covered = mergedCovered(text);
  const lines = [];
  let rowNo = 0;
  let row = null;
  let cell = null;
  let col = -1;
  let inV = 0;
  let inIs = 0;
  let inT = 0;
  let skip = 0;
  let collapsed = 0;
  const value = (c) => {
    const v = c.v;
    switch (c.t) {
      case 's':
        return strings[Number(v)] ?? '';
      case 'inlineStr':
        return c.is;
      case 'str':
      case 'e':
      case 'd':
        return v;
      case 'b':
        return v === '' ? '' : truthy(v) ? 'TRUE' : 'FALSE';
      default: {
        if (v.trim() === '') return '';
        const date = serialText(Number(v), kinds[c.s] ?? null, date1904);
        return date ?? numberText(v);
      }
    }
  };
  sax(text, {
    open(el) {
      if (!NS.sml.has(el.ns)) return;
      if (el.local === 'row') {
        const r = Number(el.attrs.get('|r'));
        rowNo = Number.isInteger(r) && r > 0 ? r : rowNo + 1;
        row = new Map();
        col = -1;
      } else if (el.local === 'c' && row) {
        const ref = el.attrs.get('|r');
        const c = ref ? columnIndex(ref) : null;
        col = c ?? col + 1;
        cell = { t: el.attrs.get('|t') ?? 'n', s: Number(el.attrs.get('|s') ?? 0), v: '', is: '' };
      } else if (el.local === 'v' && cell) inV++;
      else if (el.local === 'is' && cell) inIs++;
      else if (el.local === 't' && inIs) inT++;
      else if (el.local === 'rPh') skip++;
    },
    close(el) {
      if (!NS.sml.has(el.ns)) return;
      if (el.local === 'c' && cell) {
        if (!covered.has(`${rowNo}:${col}`)) {
          const v = cellText(value(cell));
          if (v) row.set(col, v);
        }
        cell = null;
      } else if (el.local === 'row' && row) {
        const line = joinCells(row, () => collapsed++);
        if (line !== null) {
          ctx.guard(line);
          lines.push(`[${rowNo}] ${line}`);
        }
        row = null;
      } else if (el.local === 'v') inV--;
      else if (el.local === 'is') inIs--;
      else if (el.local === 't' && inIs) inT--;
      else if (el.local === 'rPh') skip--;
    },
    text(s) {
      if (!cell || skip) return;
      if (inV) cell.v += s;
      else if (inIs && inT) cell.is += s;
    },
  });
  if (collapsed) ctx.warn(`sheet ${sheetNo}: runs of more than 64 empty cells shown as "…" (${collapsed})`);
  return lines.join('\n');
}

export function extractXlsx(buf, ctx) {
  const zip = new Zip(buf, { maxDocBytes: ctx.maxDocBytes });
  const wbPart = mainPart(zip, 'xl/workbook.xml');
  const wb = xmlPart(zip, wbPart);
  if (!wb) throw new Error(`no workbook part ${wbPart}`);
  const rels = relsOf(zip, wbPart);
  const date1904 = truthy(attr(findAll(wb, NS.sml, 'workbookPr')[0], '', 'date1904'));
  const strings = sharedStrings(zip, relOfType(rels, 'sharedStrings')?.target);
  const styles = relOfType(rels, 'styles')?.target;
  const kinds = styles ? styleKinds(zip, styles) : [];
  const sections = [];
  const sheets = kids(findAll(wb, NS.sml, 'sheets')[0], NS.sml, 'sheet');
  sheets.forEach((sh, i) => {
    const n = i + 1;
    const name = attr(sh, '', 'name') ?? `Sheet${n}`;
    const state = attr(sh, '', 'state');
    const hidden = state === 'hidden' || state === 'veryHidden';
    const rel = rels.find((r) => r.id === attr(sh, NS.r, 'id'));
    let text = '';
    if (rel && rel.type.endsWith('/worksheet')) {
      const part = readPart(zip, rel.target);
      if (part) text = sheetRows(decodeXml(part).text, { strings, kinds, date1904, ctx, sheetNo: n });
    }
    // Chart sheets, dialog sheets and macro sheets: the marker only.
    sections.push({ marker: `--- sheet ${n}: ${markerLabel(name)}${hidden ? ' (hidden)' : ''} ---`, kind: 'sheet', n, label: name, text });
  });
  return { sections };
}
