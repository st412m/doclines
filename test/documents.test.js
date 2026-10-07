// Presentations, ODT, EPUB and FB2 built in memory, and sections per family on the
// fixtures.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extract, sectionOf } from '../src/index.js';
import { fxPath, zip } from './helpers.js';

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const rels = (list) => `<Relationships xmlns="${PKG}">${list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('')}</Relationships>`;
const para = (...runs) => `<a:p>${runs.join('')}</a:p>`;
const run = (t) => `<a:r><a:t>${t}</a:t></a:r>`;
const sp = (ph, ...paras) => `<p:sp><p:nvSpPr><p:cNvPr id="1" name=""/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ''}</p:nvPr></p:nvSpPr><p:txBody>${paras.join('')}</p:txBody></p:sp>`;

test('PPTX: sldIdLst order, hidden, groups, AlternateContent, tables, SmartArt, furniture skipped, notes body only', async () => {
  const slideA =
    `<p:sld ${P}><p:cSld><p:spTree>` +
    sp('title', para(run('First'))) +
    sp(null, para(run('line one'), '<a:br/>', run('line two')), para(run('page '), '<a:fld type="slidenum"><a:t>7</a:t></a:fld>')) +
    sp('sldNum', para(run('‹#›'))) +
    sp('dt', para(run('2026-10-07'))) +
    sp('ftr', para(run('footer'))) +
    `<p:grpSp><p:grpSpPr/>${sp(null, para(run('in group')))}<p:grpSp>${sp(null, para(run('nested group')))}</p:grpSp></p:grpSp>` +
    '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="p14">' + sp(null, para(run('choice'))) + '</mc:Choice><mc:Fallback>' + sp(null, para(run('fallback'))) + '</mc:Fallback></mc:AlternateContent>' +
    '<p:graphicFrame><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>' +
    `<a:tr><a:tc><a:txBody>${para(run('A'))}</a:txBody></a:tc><a:tc gridSpan="2"><a:txBody>${para(run('B'))}</a:txBody></a:tc><a:tc hMerge="1"><a:txBody>${para(run('x'))}</a:txBody></a:tc></a:tr>` +
    `<a:tr><a:tc><a:txBody>${para()}</a:txBody></a:tc></a:tr>` +
    '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>' +
    '<p:graphicFrame><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" r:dm="rD"/></a:graphicData></a:graphic></p:graphicFrame>' +
    '<p:pic/>' +
    '</p:spTree></p:cSld></p:sld>';
  const slideB = `<p:sld ${P} show="0"><p:cSld><p:spTree>${sp('title', para(run('Second')))}</p:spTree></p:cSld></p:sld>`;
  const data = `<dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><dgm:ptLst><dgm:pt><dgm:t><a:bodyPr/>${para(run('smart one'))}</dgm:t></dgm:pt><dgm:pt><dgm:t>${para(run('smart two'))}</dgm:t></dgm:pt></dgm:ptLst></dgm:dataModel>`;
  const notes = `<p:notes ${P}><p:cSld><p:spTree>${sp('sldImg')}${sp('body', para(run('the notes')))}${sp('sldNum', para(run('<number>')))}</p:spTree></p:cSld></p:notes>`;
  const deck = zip([
    { name: '_rels/.rels', data: rels([['r1', 'officeDocument', 'ppt/presentation.xml']]) },
    { name: 'ppt/presentation.xml', data: `<p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rB"/><p:sldId id="257" r:id="rA"/></p:sldIdLst></p:presentation>` },
    { name: 'ppt/_rels/presentation.xml.rels', data: rels([['rA', 'slide', 'slides/slide1.xml'], ['rB', 'slide', 'slides/slide2.xml']]) },
    { name: 'ppt/slides/slide1.xml', data: slideA, deflate: true },
    { name: 'ppt/slides/slide2.xml', data: slideB },
    { name: 'ppt/slides/_rels/slide1.xml.rels', data: rels([['rD', 'diagramData', '../diagrams/data1.xml'], ['rN', 'notesSlide', '../notesSlides/notesSlide1.xml']]) },
    { name: 'ppt/diagrams/data1.xml', data },
    { name: 'ppt/notesSlides/notesSlide1.xml', data: notes },
  ]);
  const r = await extract(deck, { name: 'd.pptx' });
  assert.equal(r.format, 'pptx');
  assert.deepEqual(r.lines, ['Second', 'First', 'line one', 'line two', 'page', 'in group', 'nested group', 'fallback', 'A | B', 'smart one', 'smart two', 'the notes']);
  assert.deepEqual(r.markers, [
    { at: 0, text: '--- slide 1 (hidden) ---' },
    { at: 1, text: '--- slide 2 ---' },
    { at: 11, text: '--- notes 2 ---' },
  ]);
  assert.deepEqual(r.sections.map((s) => [s.kind, s.n, s.start, s.end]), [['slide', 1, 1, 1], ['slide', 2, 2, 11], ['notes', 2, 12, 12]]);
});

const ODF_NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/"';

test('ODT: white space, lists, text boxes, notes to trailing sections, tracked deletions and comments skipped', async () => {
  const body =
    '<text:tracked-changes><text:changed-region text:id="c1"><text:deletion><text:p>DELETED TEXT</text:p></text:deletion></text:changed-region></text:tracked-changes>' +
    '<text:h>  Heading   with  spaces </text:h>' +
    '<text:p>a<text:s text:c="3"/>b<text:tab/>c<text:line-break/>next line<text:change text:change-id="c1"/></text:p>' +
    '<text:p>Body<text:note text:note-class="footnote"><text:note-citation>1</text:note-citation><text:note-body><text:p>Foot note.</text:p></text:note-body></text:note> text<text:note text:note-class="endnote"><text:note-citation>i</text:note-citation><text:note-body><text:p>End note.</text:p></text:note-body></text:note>.</text:p>' +
    '<text:p>Commented<office:annotation><dc:creator>A</dc:creator><text:p>THE COMMENT</text:p></office:annotation> word</text:p>' +
    '<text:list><text:list-item><text:p>item one</text:p><text:list><text:list-item><text:p>sub item</text:p></text:list-item></text:list></text:list-item></text:list>' +
    '<text:p>Anchor<draw:frame><draw:text-box><text:p>in a text box</text:p></draw:text-box></draw:frame></text:p>' +
    '<text:section><text:p>in a section</text:p></text:section>';
  const content = `<office:document-content ${ODF_NS}><office:body><office:text>${body}</office:text></office:body></office:document-content>`;
  const odt = zip([{ name: 'mimetype', data: 'application/vnd.oasis.opendocument.text' }, { name: 'content.xml', data: content, deflate: true }]);
  const r = await extract(odt, { name: 'n.odt' });
  assert.deepEqual(r.lines, ['Heading with spaces', 'a   b\tc', 'next line', 'Body text.', 'Commented word', 'item one', 'sub item', 'Anchor', 'in a text box', 'in a section', 'Foot note.', 'End note.']);
  assert.deepEqual(r.markers, [{ at: 10, text: '--- footnotes ---' }, { at: 11, text: '--- endnotes ---' }]);
  assert.deepEqual(r.sections.map((s) => s.kind), ['footnotes', 'endnotes']);
});

const xhtml = (title, body) => `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body>${body}</body></html>`;

test('EPUB: spine order with non-linear items, hrefs relative to the package and percent-decoded, titles, skipped items', async () => {
  const opf =
    '<package xmlns="http://www.idpf.org/2007/opf" version="2.0"><manifest>' +
    '<item id="c2" href="text/Chapter%20Two.xhtml" media-type="application/xhtml+xml"/>' +
    '<item id="c1" href="text/one.xhtml" media-type="application/xhtml+xml"/>' +
    '<item id="note" href="text/notes.xhtml" media-type="application/xhtml+xml"/>' +
    '<item id="img" href="img/cover.jpg" media-type="image/jpeg"/>' +
    '<item id="blank" href="text/blank.xhtml" media-type="application/xhtml+xml"/>' +
    '<item id="gone" href="text/missing.xhtml" media-type="application/xhtml+xml"/>' +
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' +
    '</manifest><spine><itemref idref="c1"/><itemref idref="img"/><itemref idref="blank"/><itemref idref="note" linear="no"/><itemref idref="c2"/><itemref idref="gone"/></spine></package>';
  const book = zip([
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' },
    { name: 'OPS/book.opf', data: opf },
    { name: 'OPS/text/one.xhtml', data: xhtml('Head title', '<h2>Real <i>heading</i></h2><p>first text</p>'), deflate: true },
    { name: 'OPS/text/Chapter Two.xhtml', data: xhtml('Second title', '<p>second text</p>') },
    { name: 'OPS/text/notes.xhtml', data: xhtml('', '<p>a note</p>') },
    { name: 'OPS/text/blank.xhtml', data: xhtml('Blank', '<div>  </div>') },
    { name: 'OPS/nav.xhtml', data: xhtml('Nav', '<nav><ol><li>NAV ENTRY</li></ol></nav>') },
  ]);
  const r = await extract(book, { name: 'b.epub' });
  assert.deepEqual(r.markers.map((m) => m.text), ['--- chapter 1: Real heading ---', '--- chapter 2: notes.xhtml ---', '--- chapter 3: Second title ---']);
  assert.deepEqual(r.lines, ['Real heading', 'first text', 'a note', 'second text']);
  assert.deepEqual(r.sections.map((s) => [s.kind, s.n, s.label]), [['chapter', 1, 'Real heading'], ['chapter', 2, 'notes.xhtml'], ['chapter', 3, 'Second title']]);
  assert.ok(r.warnings.includes('spine item OPS/text/missing.xhtml is missing'));
});

test('FB2: title-info first, sections as chapters, poems, citations, epigraphs, tables, empty lines, notes; binary and note refs skipped', async () => {
  const fb2 =
    '\ufeff<?xml version="1.0" encoding="windows-1251"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">' +
    '<description><title-info><author><first-name>Анна</first-name><middle-name>Б.</middle-name><last-name>Вега</last-name></author><author><nickname>nick</nickname></author><book-title>Книга</book-title></title-info></description>' +
    '<body><title><p>Книга</p></title><epigraph><p>Body epigraph</p><text-author>Someone</text-author></epigraph>' +
    '<section><title><p>Part</p><p>One</p></title><p>Text<a l:href="#n1" type="note">1</a> here.</p><empty-line/><p>After gap</p>' +
    '<poem><title><p>Poem</p></title><stanza><v>verse one</v><v>verse two</v></stanza></poem><cite><p>cited</p><text-author>Author</text-author></cite>' +
    '<table><tr><th>H1</th><th>H2</th></tr><tr><td>a</td><td/></tr></table><image l:href="#pic"/><section><title><p>Sub</p></title><p>sub text</p></section></section>' +
    '<section><p>untitled section</p></section></body>' +
    '<body name="notes"><section id="n1"><title><p>1</p></title><p>The note.</p></section></body>' +
    '<binary id="pic" content-type="image/png">iVBORw0KGgo=</binary></FictionBook>';
  const r = await extract(Buffer.from(fb2), { name: 'b.fb2' });
  assert.equal(r.format, 'fb2');
  assert.equal(r.charset, 'utf-8', 'the BOM wins over the declaration');
  assert.deepEqual(r.lines, ['Книга', 'Анна Б. Вега', 'nick', 'Body epigraph', 'Someone', 'Part', 'One', 'Text here.', '', 'After gap', 'Poem', 'verse one', 'verse two', 'cited', 'Author', 'H1 | H2', 'a', 'Sub', 'sub text', 'untitled section', '1', 'The note.']);
  assert.deepEqual(r.markers.map((m) => m.text), ['--- chapter 1: Part One ---', '--- chapter 2 ---', '--- notes ---']);
  assert.deepEqual(r.sections.map((s) => [s.kind, s.n, s.label]), [['chapter', 1, 'Part One'], ['chapter', 2, null], ['notes', null, null]]);
});

test('sections per family on the fixtures: sheet, slide/notes, chapter, footnotes, notes', async () => {
  const kinds = async (f) => (await extract(fxPath(f))).sections.map((s) => `${s.kind}${s.n ?? ''}`);
  assert.deepEqual(await kinds('text.xlsx'), ['sheet1', 'sheet2', 'sheet3']);
  assert.deepEqual(await kinds('text.ods'), ['sheet1', 'sheet2', 'sheet3']);
  assert.deepEqual(await kinds('text.pptx'), ['slide1', 'notes1', 'slide2', 'slide3', 'slide4', 'notes4']);
  assert.deepEqual(await kinds('text.odp'), ['slide1', 'notes1', 'slide2', 'slide3', 'slide4', 'notes4']);
  assert.deepEqual(await kinds('text.epub'), ['chapter1', 'chapter2', 'chapter3']);
  assert.deepEqual(await kinds('text.fb2'), ['chapter1', 'chapter2', 'notes']);
  assert.deepEqual(await kinds('notes.odt'), ['footnotes']);
  const p = await extract(fxPath('text.pptx'));
  const line = p.lines.indexOf('Hidden slide text') + 1;
  assert.deepEqual([sectionOf(p, line).kind, sectionOf(p, line).n], ['slide', 3]);
});

test('maxTextBytes holds for the new formats too', async () => {
  for (const f of ['text.xlsx', 'text.ods', 'text.pptx', 'text.odp', 'text.odt', 'text.epub', 'text.fb2']) {
    await assert.rejects(extract(fxPath(f), { maxTextBytes: 50 }), (e) => e.code === 'text_too_large', f);
  }
});
