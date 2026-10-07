// Spreadsheets: XLSX and ODS built in memory — cell types, dates, merged cells, empty
// runs, repeats, sheet sections and markers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extract, sectionOf } from '../src/index.js';
import { markerLabel } from '../src/normalize.js';
import { dateKind, joinCells, odfDateText, odfDurationText, serialText } from '../src/sheet.js';
import { zip } from './helpers.js';

const SML = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** An XLSX: sheets [{ name, state, xml (sheetData inner) | chart: true }], strings, numFmts, xfs (numFmtId per style). */
function xlsx({ sheets, strings = [], numFmts = {}, xfs = [0], date1904 = false, ns = SML }) {
  const rels = [];
  const entries = [];
  const wbSheets = sheets.map((s, i) => {
    const id = `rId${i + 1}`;
    const type = s.chart ? 'chartsheet' : 'worksheet';
    rels.push(`<Relationship Id="${id}" Type="${REL}/${type}" Target="${type}s/sheet${i + 1}.xml"/>`);
    entries.push({ name: `xl/${type}s/sheet${i + 1}.xml`, data: s.chart ? `<chartsheet xmlns="${ns}"/>` : `<x:worksheet xmlns:x="${ns}" xmlns="${ns}"><x:sheetData>${s.xml}</x:sheetData>${s.tail ?? ''}</x:worksheet>`, deflate: true });
    return `<sheet name="${s.name}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ''} r:id="${id}"/>`;
  });
  rels.push(`<Relationship Id="rS" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>`, `<Relationship Id="rT" Type="${REL}/styles" Target="styles.xml"/>`);
  entries.push(
    { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: '_rels/.rels', data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `<workbook xmlns="${ns}" xmlns:r="${REL}"><workbookPr date1904="${date1904 ? 1 : 0}"/><sheets>${wbSheets.join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>` },
    { name: 'xl/sharedStrings.xml', data: `<sst xmlns="${ns}">${strings.map((s) => `<si>${s}</si>`).join('')}</sst>` },
    {
      name: 'xl/styles.xml',
      data: `<styleSheet xmlns="${ns}"><numFmts>${Object.entries(numFmts)
        .map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${code.replace(/"/g, '&quot;')}"/>`)
        .join('')}</numFmts><cellXfs>${xfs.map((id) => `<xf numFmtId="${id}"/>`).join('')}</cellXfs></styleSheet>`,
    },
  );
  return zip(entries);
}

const n = (ref, v, s = 0) => `<c r="${ref}" s="${s}"><v>${v}</v></c>`;

test('dateKind: built-in ids, custom codes, quoted text, escapes, brackets, elapsed time', () => {
  assert.deepEqual([14, 18, 22, 45, 46, 47, 0, 2, 49].map((id) => dateKind(id, null)), ['date', 'time', 'datetime', 'time', 'elapsed', 'time', null, null, null]);
  assert.equal(dateKind(31, null), 'auto');
  const kinds = {
    'yyyy\\-mm\\-dd': 'date',
    'dd.mm.yyyy hh:mm': 'datetime',
    'hh:mm:ss': 'time',
    'h:mm AM/PM': 'time',
    'mmm-yy': 'date',
    '[h]:mm': 'elapsed',
    '[HH]:MM': 'elapsed',
    '[mm]:ss': 'elapsed',
    '[S]': 'elapsed',
    '[Red]0.00': null,
    '"day" 0': null,
    '0.00 "mm"': null,
    '#,##0.00 [$руб.-419]': null,
    General: null,
    '0%': null,
    '[Red]d/m/yy': 'date',
    '\\d\\a\\y 0': null,
  };
  for (const [code, kind] of Object.entries(kinds)) assert.equal(dateKind(164, code), kind, code);
});

test('serialText: 1900 system with the Lotus leap year, 1904 system, time, rounding', () => {
  assert.equal(serialText(1, 'date'), '1900-01-01');
  assert.equal(serialText(59, 'date'), '1900-02-28');
  assert.equal(serialText(60, 'date'), '1900-02-29');
  assert.equal(serialText(61, 'date'), '1900-03-01');
  assert.equal(serialText(46353, 'date'), '2026-11-27');
  assert.equal(serialText(44891, 'date', true), '2026-11-27');
  assert.equal(serialText(0, 'date', true), '1904-01-01');
  assert.equal(serialText(46070.4583333333, 'datetime'), '2026-02-17 11:00:00');
  assert.equal(serialText(0.458333333333333, 'time'), '11:00:00');
  assert.equal(serialText(0.99999999, 'datetime'), '1900-01-01 00:00:00');
  assert.equal(serialText(1.5, 'elapsed'), '36:00:00');
  assert.equal(serialText(0.0416666666666667, 'elapsed'), '01:00:00');
  assert.equal(serialText(-1.5, 'elapsed'), null, 'a negative value stays a number');
  assert.equal(serialText(46353, 'auto'), '2026-11-27');
  assert.equal(serialText(0.25, 'auto'), '06:00:00');
  assert.equal(serialText(-1, 'date'), null);
  assert.equal(serialText(5, null), null);
});

test('joinCells and markerLabel', () => {
  assert.equal(joinCells(['a', '', 'c', '', '']), 'a |  | c');
  assert.equal(joinCells(['', '', '']), null);
  let runs = 0;
  const far = new Map([[0, 'A'], [65, 'B'], [131, 'C']]);
  assert.equal(joinCells(far, () => runs++), `A | ${Array(64).fill('').join(' | ')} | B | … | C`);
  assert.equal(runs, 1);
  assert.equal(markerLabel('a\nb\r\n\tc\u0007d'), 'a b cd');
  assert.equal(markerLabel('x'.repeat(200)).length, 120);
  assert.equal(odfDateText('2026-02-17T11:00:00.250'), '2026-02-17 11:00:00');
  assert.equal(odfDateText('2026-02-17T11:00'), '2026-02-17 11:00:00');
  assert.equal(odfDurationText('PT36H00M00S'), '36:00:00');
  assert.equal(odfDurationText('P1DT2H30M15.6S'), '26:30:16');
  assert.equal(odfDurationText('-PT1H'), '-01:00:00');
});

test('XLSX: cell types, shared/inline/rich strings, formulas, dates by style, merged cells', async () => {
  const book = xlsx({
    strings: ['<t>plain</t>', '<r><t>ri</t></r><r><t>ch</t></r><rPh><t>PHONETIC</t></rPh>', '<t>two\nlines</t>', '<t>merged</t>', '<t>covered</t>'],
    numFmts: { 164: 'yyyy-mm-dd', 165: 'hh:mm:ss', 166: '[h]:mm' },
    xfs: [0, 164, 165, 166, 22, 14],
    sheets: [
      {
        name: 'Types',
        xml:
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>in</t><r><t>line</t></r></is></c><c r="D1" t="str"><f>A1</f><v>calc</v></c></row>' +
          '<row r="2"><c r="A2" t="b"><v>1</v></c><c r="B2" t="b"><v>0</v></c><c r="C2" t="e"><v>#DIV/0!</v></c><c r="D2"><f>1/0</f></c><c r="E2" t="d"><v>2026-11-27T10:00:00</v></c><c r="F2" t="s"><v>2</v></c></row>' +
          `<row r="3">${n('A3', 60, 1)}${n('B3', 0.5, 2)}${n('C3', 1.5, 3)}${n('D3', 46070.25, 4)}${n('E3', 46353, 5)}${n('F3', '1E-3')}${n('G3', '-0')}</row>` +
          '<row r="5"><c r="A5" t="s"><v>3</v></c><c r="B5" t="s"><v>4</v></c><c r="D5"><v>7</v></c></row>' +
          '<row><c t="inlineStr"><is><t>no refs</t></is></c><c><v>8</v></c></row>',
        tail: '<mergeCells count="1"><mergeCell ref="A5:C5"/></mergeCells>',
      },
    ],
  });
  const r = await extract(book, { name: 't.xlsx' });
  assert.deepEqual(r.lines, [
    '[1] plain | rich | inline | calc',
    '[2] TRUE | FALSE | #DIV/0! |  | 2026-11-27T10:00:00 | two lines',
    '[3] 1900-02-29 | 12:00:00 | 36:00:00 | 2026-02-17 06:00:00 | 2026-11-27 | 0.001 | 0',
    '[5] merged |  |  | 7',
    '[6] no refs | 8',
  ]);
  assert.deepEqual(r.markers, [{ at: 0, text: '--- sheet 1: Types ---' }]);
});

test('XLSX: sheet order, hidden and very hidden, chart sheets marker only, names in markers; Strict namespace; 1904', async () => {
  const book = xlsx({
    ns: 'http://purl.oclc.org/ooxml/spreadsheetml/main',
    date1904: true,
    xfs: [0, 14],
    sheets: [
      { name: 'B&amp;a\nme', xml: `<row r="1">${n('A1', 0, 1)}</row>` },
      { name: 'Hidden', state: 'hidden', xml: '<row r="2"><c r="B2" t="inlineStr"><is><t>h</t></is></c></row>' },
      { name: 'Chart', chart: true },
      { name: 'Very', state: 'veryHidden', xml: '' },
    ],
  });
  const r = await extract(book, { name: 's.xlsx' });
  assert.deepEqual(r.markers.map((m) => m.text), ['--- sheet 1: B&a me ---', '--- sheet 2: Hidden (hidden) ---', '--- sheet 3: Chart ---', '--- sheet 4: Very (hidden) ---']);
  assert.deepEqual(r.lines, ['[1] 1904-01-01', '[2]  | h']);
  assert.deepEqual(
    r.sections.map((s) => [s.kind, s.n, s.label, s.start, s.end]),
    [
      ['sheet', 1, 'B&a\nme', 1, 1],
      ['sheet', 2, 'Hidden', 2, 2],
      ['sheet', 3, 'Chart', 3, 2],
      ['sheet', 4, 'Very', 3, 2],
    ],
  );
  assert.equal(sectionOf(r, 2).label, 'Hidden');
});

test('XLSX: more than 64 empty cells collapse to "…" with a warning', async () => {
  const r = await extract(xlsx({ sheets: [{ name: 'S', xml: `<row r="4">${n('A4', 1)}${n('CA4', 2)}</row>` }] }), { name: 'w.xlsx' });
  assert.deepEqual(r.lines, ['[4] 1 | … | 2']);
  assert.deepEqual(r.warnings.filter((w) => !w.startsWith('heap cap')), ['sheet 1: runs of more than 64 empty cells shown as "…" (1)']);
});

// ---- ODS ----

const ODS_NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"';

function ods(tables, styles = '') {
  const content = `<office:document-content ${ODS_NS}><office:automatic-styles>${styles}</office:automatic-styles><office:body><office:spreadsheet>${tables}</office:spreadsheet></office:body></office:document-content>`;
  return zip([{ name: 'mimetype', data: 'application/vnd.oasis.opendocument.spreadsheet' }, { name: 'content.xml', data: content, deflate: true }]);
}
const cell = (v, extra = '') => `<table:table-cell office:value-type="string"${extra}><text:p>${v}</text:p></table:table-cell>`;

test('ODS: empty repeats advance without output, non-empty repeats expand up to 1000 with a warning', async () => {
  const t =
    '<table:table table:name="R">' +
    `<table:table-row>${cell('a')}<table:table-cell table:number-columns-repeated="2"/>${cell('b', ' table:number-columns-repeated="2"')}<table:table-cell table:number-columns-repeated="16380"/></table:table-row>` +
    '<table:table-row table:number-rows-repeated="1048570"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>' +
    `<table:table-row>${cell('after')}</table:table-row>` +
    `<table:table-row table:number-rows-repeated="1500">${cell('rep')}</table:table-row>` +
    `<table:table-row>${cell('last')}</table:table-row>` +
    '</table:table>';
  const r = await extract(ods(t), { name: 'r.ods' });
  assert.equal(r.lines[0], '[1] a |  |  | b | b');
  assert.equal(r.lines[1], '[1048572] after');
  assert.equal(r.lines.length, 1 + 1 + 1000 + 1);
  assert.equal(r.lines[2], '[1048573] rep');
  assert.equal(r.lines[1001], '[1049572] rep');
  assert.equal(r.lines.at(-1), '[1050073] last');
  assert.ok(r.warnings.includes('repeated rows or cells written out at most 1000 times'));
});

test('ODS: value types, covered cells, hidden tables, annotations skipped, white space', async () => {
  const styles = '<style:style style:name="hid" style:family="table"><style:table-properties table:display="false"/></style:style>';
  const t =
    '<table:table table:name="V">' +
    '<table:table-row>' +
    '<table:table-cell office:value-type="float" office:value="3605044"><text:p>3 605 044</text:p></table:table-cell>' +
    '<table:table-cell office:value-type="currency" office:value="-0.5"><text:p>-0.50 €</text:p></table:table-cell>' +
    '<table:table-cell office:value-type="boolean" office:boolean-value="false"><text:p>FALSE</text:p></table:table-cell>' +
    '<table:table-cell office:value-type="date" office:date-value="2026-11-27T08:30:00"><text:p>x</text:p></table:table-cell>' +
    '<table:table-cell office:value-type="time" office:time-value="PT01H02M03S"><text:p>x</text:p></table:table-cell>' +
    '<table:table-cell office:value-type="string"><office:annotation><text:p>comment</text:p></office:annotation><text:p>  two   spaces<text:s text:c="2"/>kept<text:tab/>tab</text:p></table:table-cell>' +
    '</table:table-row>' +
    `<table:table-row>${cell('merged', ' table:number-columns-spanned="2"')}<table:covered-table-cell>${'<text:p>covered</text:p>'}</table:covered-table-cell>${cell('next')}</table:table-row>` +
    '</table:table>' +
    `<table:table table:name="H" table:style-name="hid"><table:table-row>${cell('h')}</table:table-row></table:table>`;
  const r = await extract(ods(t, styles), { name: 'v.ods' });
  assert.deepEqual(r.lines, ['[1] 3605044 | -0.5 | FALSE | 2026-11-27 08:30:00 | 01:02:03 | two spaces  kept tab', '[2] merged |  | next', '[1] h']);
  assert.deepEqual(r.markers.map((m) => m.text), ['--- sheet 1: V ---', '--- sheet 2: H (hidden) ---']);
});
