// XML through htmlparser2 in xmlMode: no DTD processing, no external or custom
// entities (only the predefined XML entities and character references are decoded).
// Element and attribute names are resolved through their xmlns declarations, so
// formats are matched by namespace URI + local name, never by a prefix.
import { Parser } from 'htmlparser2';
import { decoderFor } from './html.js';

const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const OOXML = (path) => [`http://schemas.openxmlformats.org/${path}`];

export const NS = {
  rel: new Set(['http://schemas.openxmlformats.org/package/2006/relationships']),
  ct: new Set(['http://schemas.openxmlformats.org/package/2006/content-types']),
  // Transitional and Strict (ISO/IEC 29500) namespaces.
  sml: new Set([...OOXML('spreadsheetml/2006/main'), 'http://purl.oclc.org/ooxml/spreadsheetml/main']),
  r: new Set([...OOXML('officeDocument/2006/relationships'), 'http://purl.oclc.org/ooxml/officeDocument/relationships']),
  pml: new Set([...OOXML('presentationml/2006/main'), 'http://purl.oclc.org/ooxml/presentationml/main']),
  dml: new Set([...OOXML('drawingml/2006/main'), 'http://purl.oclc.org/ooxml/drawingml/main']),
  dgm: new Set([...OOXML('drawingml/2006/diagram'), 'http://purl.oclc.org/ooxml/drawingml/diagram']),
  mc: new Set(['http://schemas.openxmlformats.org/markup-compatibility/2006']),
  office: new Set(['urn:oasis:names:tc:opendocument:xmlns:office:1.0']),
  text: new Set(['urn:oasis:names:tc:opendocument:xmlns:text:1.0']),
  table: new Set(['urn:oasis:names:tc:opendocument:xmlns:table:1.0']),
  draw: new Set(['urn:oasis:names:tc:opendocument:xmlns:drawing:1.0']),
  presentation: new Set(['urn:oasis:names:tc:opendocument:xmlns:presentation:1.0']),
  style: new Set(['urn:oasis:names:tc:opendocument:xmlns:style:1.0']),
  manifest: new Set(['urn:oasis:names:tc:opendocument:xmlns:manifest:1.0']),
  container: new Set(['urn:oasis:names:tc:opendocument:xmlns:container']),
  opf: new Set(['http://www.idpf.org/2007/opf']),
  xmlenc: new Set(['http://www.w3.org/2001/04/xmlenc#']),
  fb2: new Set(['http://www.gribuser.ru/xml/fictionbook/2.0']),
  xlink: new Set(['http://www.w3.org/1999/xlink']),
  none: new Set(['']),
};

/** XML bytes → text: BOM (UTF-8/UTF-16), else the encoding of the XML declaration, else UTF-8. */
export function decodeXml(buf, name = 'input') {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), charset: 'utf-8' };
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), charset: 'utf-16le' };
  if (buf[0] === 0xfe && buf[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), charset: 'utf-16be' };
  const decl = /^\s*<\?xml[^>]*?\bencoding\s*=\s*["']([A-Za-z0-9._:-]+)["']/.exec(buf.subarray(0, 200).toString('latin1'));
  const dec = decl ? decoderFor(decl[1], name) : null;
  if (dec && !dec.encoding.startsWith('utf-16')) return { text: dec.decode(buf), charset: dec.encoding };
  return { text: new TextDecoder('utf-8').decode(buf), charset: 'utf-8' };
}

/**
 * Streams `text` to { open(el), close(el), text(s) }. `el` = { ns, local, attrs } with
 * attrs a Map from "ns|local" (ns '' for unprefixed attributes) to the value.
 */
export function sax(text, handlers) {
  const scopes = [new Map([['xml', XML_NS]])];
  const stack = [];
  const resolve = (scope, qname, isAttr) => {
    const i = qname.indexOf(':');
    if (i < 0) return { ns: isAttr ? '' : (scope.get('') ?? ''), local: qname };
    return { ns: scope.get(qname.slice(0, i)) ?? `unbound:${qname.slice(0, i)}`, local: qname.slice(i + 1) };
  };
  const parser = new Parser(
    {
      onopentag(qname, attribs) {
        let scope = scopes.at(-1);
        for (const k of Object.keys(attribs)) {
          if (k === 'xmlns' || k.startsWith('xmlns:')) {
            if (scope === scopes.at(-1)) scope = new Map(scope);
            scope.set(k === 'xmlns' ? '' : k.slice(6), attribs[k]);
          }
        }
        scopes.push(scope);
        const { ns, local } = resolve(scope, qname, false);
        const attrs = new Map();
        for (const [k, v] of Object.entries(attribs)) {
          if (k === 'xmlns' || k.startsWith('xmlns:')) continue;
          const a = resolve(scope, k, true);
          attrs.set(`${a.ns}|${a.local}`, v);
        }
        const el = { ns, local, attrs };
        stack.push(el);
        handlers.open?.(el);
      },
      onclosetag() {
        const el = stack.pop();
        scopes.pop();
        if (el) handlers.close?.(el);
      },
      ontext(s) {
        handlers.text?.(s);
      },
    },
    { xmlMode: true, decodeEntities: true, recognizeCDATA: true },
  );
  parser.write(text);
  parser.end();
}

/** The document as a tree: elements { ns, local, attrs, children: (element | string)[] }. */
export function parseXml(text) {
  const root = { ns: '', local: '#document', attrs: new Map(), children: [] };
  const stack = [root];
  sax(text, {
    open(el) {
      el.children = [];
      stack.at(-1).children.push(el);
      stack.push(el);
    },
    close() {
      stack.pop();
    },
    text(s) {
      const c = stack.at(-1).children;
      if (typeof c.at(-1) === 'string') c[c.length - 1] += s;
      else c.push(s);
    },
  });
  return root;
}

const match = (set, v) => set === undefined || (set instanceof Set ? set.has(v) : set === v);

export function is(el, ns, local) {
  return typeof el === 'object' && el !== null && match(ns, el.ns) && match(local, el.local);
}

export function attr(el, ns, local) {
  if (!el) return null;
  for (const u of ns instanceof Set ? ns : [ns]) {
    const v = el.attrs.get(`${u}|${local}`);
    if (v !== undefined) return v;
  }
  return null;
}

/** Element children, optionally only those matching ns/local. */
export function kids(el, ns, local) {
  return (el?.children ?? []).filter((c) => typeof c === 'object' && match(ns, c.ns) && match(local, c.local));
}

export function child(el, ns, local) {
  return kids(el, ns, local)[0] ?? null;
}

/** The first descendant (depth first) matching ns/local, or null. */
export function find(el, ns, local) {
  for (const c of el?.children ?? []) {
    if (typeof c !== 'object') continue;
    if (is(c, ns, local)) return c;
    const d = find(c, ns, local);
    if (d) return d;
  }
  return null;
}

/** Every descendant matching ns/local, in document order. */
export function findAll(el, ns, local, out = []) {
  for (const c of el?.children ?? []) {
    if (typeof c !== 'object') continue;
    if (is(c, ns, local)) out.push(c);
    findAll(c, ns, local, out);
  }
  return out;
}

/** All character data below `el`. */
export function textOf(el) {
  if (typeof el === 'string') return el;
  let s = '';
  for (const c of el?.children ?? []) s += textOf(c);
  return s;
}
