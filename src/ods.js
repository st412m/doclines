// ODS (OpenDocument 1.3 Part 3, §9.1) → one section per sheet, rows as in xlsx.js.
// content.xml is read as a stream. Values: office:value for numbers, office:date-value
// and office:time-value as ISO text, office:boolean-value as TRUE/FALSE, else the
// paragraphs of the cell. An empty repeated row or cell only advances the position; a
// non-empty one is written out at most MAX_REPEAT times.
import { odfEncryptedFull } from './formats.js';
import { markerLabel } from './normalize.js';
import { MAX_REPEAT, cellText, joinCells, numberText, odfDateText, odfDurationText } from './sheet.js';
import { NS, decodeXml, sax } from './xml.js';
import { Zip, ZipError } from './zip.js';

const T = NS.table.values().next().value;
const O = NS.office.values().next().value;
const S = NS.style.values().next().value;

export function extractOds(buf, ctx) {
  const zip = new Zip(buf, { maxDocBytes: ctx.maxDocBytes });
  if (odfEncryptedFull(zip)) throw new ZipError('encrypted', 'manifest:encryption-data');
  const content = zip.read('content.xml');
  if (!content) throw new Error('no content.xml');
  const hiddenStyles = new Set();
  const sections = [];
  let styleName = null;
  let sheet = null; // { n, name, hidden, lines, row }
  let rowNo = 0;
  let row = null; // { cells: Map, repeat, col }
  let cell = null; // { value, paras: [], cur, repeat, covered }
  let para = 0;
  let skip = 0; // inside annotations, frames, nested tables
  let sheets = 0;
  let capped = false;
  let collapsed = 0;

  const value = (c) => {
    if (c.covered) return '';
    switch (c.type) {
      case 'float':
      case 'percentage':
      case 'currency':
        return c.attrs.get(`${O}|value`) != null ? numberText(c.attrs.get(`${O}|value`)) : c.text();
      case 'date':
        return odfDateText(c.attrs.get(`${O}|date-value`));
      case 'time':
        return odfDurationText(c.attrs.get(`${O}|time-value`));
      case 'boolean': {
        const b = c.attrs.get(`${O}|boolean-value`);
        return b == null ? c.text() : b === 'true' || b === '1' ? 'TRUE' : 'FALSE';
      }
      default:
        return c.attrs.get(`${O}|string-value`) || c.text();
    }
  };

  sax(decodeXml(content).text, {
    open(el) {
      if (skip) {
        skip++;
        return;
      }
      if (NS.style.has(el.ns) && el.local === 'style') styleName = el.attrs.get(`${S}|name`);
      else if (NS.style.has(el.ns) && el.local === 'table-properties' && styleName && el.attrs.get(`${T}|display`) === 'false') hiddenStyles.add(styleName);
      else if (NS.table.has(el.ns) && el.local === 'table') {
        if (sheet) {
          skip = 1; // a table inside a cell
          return;
        }
        sheets++;
        sheet = { n: sheets, name: el.attrs.get(`${T}|name`) ?? `Sheet${sheets}`, hidden: hiddenStyles.has(el.attrs.get(`${T}|style-name`)), lines: [] };
        rowNo = 0;
      } else if (sheet && NS.table.has(el.ns) && el.local === 'table-row') {
        row = { cells: new Map(), repeat: Number(el.attrs.get(`${T}|number-rows-repeated`) ?? 1) || 1, col: 0 };
      } else if (row && NS.table.has(el.ns) && (el.local === 'table-cell' || el.local === 'covered-table-cell')) {
        const paras = [];
        cell = {
          attrs: el.attrs,
          type: el.attrs.get(`${O}|value-type`),
          repeat: Number(el.attrs.get(`${T}|number-columns-repeated`) ?? 1) || 1,
          covered: el.local === 'covered-table-cell',
          paras,
          text: () => paras.join(' '),
        };
      } else if (cell && NS.office.has(el.ns) && el.local === 'annotation') skip = 1;
      else if (cell && NS.draw.has(el.ns)) skip = 1;
      else if (cell && NS.text.has(el.ns) && (el.local === 'p' || el.local === 'h')) {
        para++;
        if (para === 1) cell.paras.push('');
      } else if (cell && para && NS.text.has(el.ns)) {
        const add = (s) => (cell.paras[cell.paras.length - 1] += s);
        if (el.local === 's') add(' '.repeat(Math.min(Number(el.attrs.get(`${NS.text.values().next().value}|c`) ?? 1) || 1, 1000)));
        else if (el.local === 'tab' || el.local === 'line-break') add(' ');
      }
    },
    close(el) {
      if (skip) {
        skip--;
        return;
      }
      if (NS.style.has(el.ns) && el.local === 'style') styleName = null;
      else if (NS.table.has(el.ns) && el.local === 'table' && sheet) {
        const s = sheet;
        sections.push({ marker: `--- sheet ${s.n}: ${markerLabel(s.name)}${s.hidden ? ' (hidden)' : ''} ---`, kind: 'sheet', n: s.n, label: s.name, text: s.lines.join('\n') });
        sheet = null;
      } else if (row && NS.table.has(el.ns) && (el.local === 'table-cell' || el.local === 'covered-table-cell') && cell) {
        const v = cellText(value(cell));
        if (v) {
          if (cell.repeat > MAX_REPEAT) capped = true;
          for (let k = 0; k < Math.min(cell.repeat, MAX_REPEAT); k++) row.cells.set(row.col + k, v);
        }
        row.col += cell.repeat;
        cell = null;
      } else if (row && NS.table.has(el.ns) && el.local === 'table-row') {
        const line = joinCells(row.cells, () => collapsed++);
        if (line === null) rowNo += row.repeat;
        else {
          if (row.repeat > MAX_REPEAT) capped = true;
          for (let k = 0; k < Math.min(row.repeat, MAX_REPEAT); k++) {
            ctx.guard(line);
            sheet.lines.push(`[${rowNo + k + 1}] ${line}`);
          }
          rowNo += row.repeat;
        }
        row = null;
      } else if (cell && NS.text.has(el.ns) && (el.local === 'p' || el.local === 'h')) para--;
    },
    text(s) {
      if (skip || !cell || !para) return;
      // ODF white space: tabs and line breaks in the text are spaces, runs collapse.
      cell.paras[cell.paras.length - 1] += s.replace(/[\t\r\n ]+/g, ' ');
    },
  });
  if (collapsed) ctx.warn(`runs of more than 64 empty cells shown as "…" (${collapsed})`);
  if (capped) ctx.warn(`repeated rows or cells written out at most ${MAX_REPEAT} times`);
  return { sections };
}
