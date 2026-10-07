// PPTX/PPTM/POTX/POTM/PPSX (ECMA-376 Part 1 PresentationML) → one section per slide
// in p:sldIdLst order ("--- slide N ---", show="0" marked hidden), then the slide's
// notes ("--- notes N ---", body placeholders only) when they have text. Shapes in
// document order, groups recursed, tables row by row; slide number, date and footer
// placeholders skipped; SmartArt text (the diagram data part) after the slide's shapes.
import { mainPart, relOfType, relsOf, xmlPart } from './opc.js';
import { joinCells } from './sheet.js';
import { NS, attr, child, find, findAll, is, kids } from './xml.js';
import { Zip } from './zip.js';

const FURNITURE = new Set(['sldNum', 'dt', 'ftr']);
const SKIP_FIELD = /^(?:slidenum|datetime)/i;

// A text body (p:txBody, a:txBody) → one entry per paragraph; a:br is a line break.
function paragraphs(body) {
  const out = [];
  for (const p of kids(body, NS.dml, 'p')) {
    let s = '';
    for (const c of kids(p)) {
      if (is(c, NS.dml, 'r')) s += findAll(c, NS.dml, 't').map((t) => t.children.join('')).join('');
      else if (is(c, NS.dml, 'br')) s += '\n';
      else if (is(c, NS.dml, 'fld') && !SKIP_FIELD.test(attr(c, '', 'type') ?? '')) s += findAll(c, NS.dml, 't').map((t) => t.children.join('')).join('');
    }
    out.push(s);
  }
  return out;
}

function placeholderType(sp) {
  const ph = find(child(sp, NS.pml, 'nvSpPr'), NS.pml, 'ph');
  return ph ? (attr(ph, '', 'type') ?? 'body') : null;
}

function tableRows(tbl, out) {
  for (const tr of kids(tbl, NS.dml, 'tr')) {
    const cells = kids(tr, NS.dml, 'tc').map((tc) => {
      if (attr(tc, '', 'hMerge') === '1' || attr(tc, '', 'vMerge') === '1') return '';
      return paragraphs(child(tc, NS.dml, 'txBody'))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    });
    const line = joinCells(cells);
    if (line !== null) out.push(line);
  }
}

/** Shapes of a shape tree → lines; `keep(sp)` filters text shapes; diagram data rel ids go to `diagrams`. */
function shapes(tree, out, { keep = () => true, diagrams = [] } = {}) {
  for (const c of kids(tree)) {
    if (is(c, NS.pml, 'sp')) {
      if (FURNITURE.has(placeholderType(c)) || !keep(c)) continue;
      out.push(...paragraphs(child(c, NS.pml, 'txBody')));
    } else if (is(c, NS.pml, 'grpSp')) shapes(c, out, { keep, diagrams });
    else if (is(c, NS.pml, 'graphicFrame')) {
      const data = find(c, NS.dml, 'graphicData');
      const tbl = child(data, NS.dml, 'tbl');
      if (tbl) tableRows(tbl, out);
      const dm = find(data, NS.dgm, 'relIds');
      if (dm) diagrams.push(attr(dm, NS.r, 'dm'));
    } else if (is(c, NS.mc, 'AlternateContent')) {
      // The Fallback is plain PresentationML; else the first Choice.
      const alt = child(c, NS.mc, 'Fallback') ?? child(c, NS.mc, 'Choice');
      if (alt) shapes(alt, out, { keep, diagrams });
    }
  }
  return out;
}

function diagramLines(zip, rels, ids) {
  const out = [];
  for (const id of ids) {
    const part = rels.find((r) => r.id === id)?.target;
    const doc = part ? xmlPart(zip, part) : null;
    for (const t of findAll(doc, NS.dgm, 't')) out.push(...paragraphs(t));
  }
  return out;
}

export function extractPptx(buf, ctx) {
  const zip = new Zip(buf, { maxDocBytes: ctx.maxDocBytes });
  const presPart = mainPart(zip, 'ppt/presentation.xml');
  const pres = xmlPart(zip, presPart);
  if (!pres) throw new Error(`no presentation part ${presPart}`);
  const rels = relsOf(zip, presPart);
  const sections = [];
  const ids = kids(find(pres, NS.pml, 'sldIdLst'), NS.pml, 'sldId');
  ids.forEach((sldId, i) => {
    const n = i + 1;
    const part = rels.find((r) => r.id === attr(sldId, NS.r, 'id'))?.target;
    const slide = part ? xmlPart(zip, part) : null;
    if (!slide) throw new Error(`slide ${n}: part missing`);
    const root = find(slide, NS.pml, 'sld');
    const hidden = ['0', 'false'].includes(attr(root, '', 'show'));
    const slideRels = relsOf(zip, part);
    const diagrams = [];
    const lines = shapes(find(slide, NS.pml, 'spTree'), [], { diagrams });
    lines.push(...diagramLines(zip, slideRels, diagrams));
    for (const l of lines) ctx.guard(l);
    sections.push({ marker: `--- slide ${n}${hidden ? ' (hidden)' : ''} ---`, kind: 'slide', n, label: null, text: lines.join('\n') });
    const notesPart = relOfType(slideRels, 'notesSlide')?.target;
    const notes = notesPart ? xmlPart(zip, notesPart) : null;
    if (notes) {
      const body = shapes(find(notes, NS.pml, 'spTree'), [], { keep: (sp) => placeholderType(sp) === 'body' });
      if (body.join('').trim()) sections.push({ marker: `--- notes ${n} ---`, kind: 'notes', n, label: null, text: body.join('\n') });
    }
  });
  return { sections };
}
