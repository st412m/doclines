// OOXML packages (ECMA-376 Part 2, OPC): parts, relationships, the main part. Part
// names compare ASCII case-insensitively.
import path from 'node:path';
import { NS, attr, findAll, parseXml, decodeXml } from './xml.js';

/** A relationship target resolved against the part that holds it, or null when it leaves the package. */
export function resolvePart(source, target) {
  if (!target) return null;
  let t;
  try {
    t = decodeURIComponent(target.split('#')[0]);
  } catch {
    t = target.split('#')[0];
  }
  const joined = t.startsWith('/') ? t.slice(1) : path.posix.join(path.posix.dirname(source), t);
  const norm = path.posix.normalize(joined);
  return norm.startsWith('..') || norm.startsWith('/') ? null : norm;
}

export function readPart(zip, name) {
  return name ? zip.read(name, { ci: true }) : null;
}

/** The part as an XML tree, or null when it is missing. */
export function xmlPart(zip, name) {
  const buf = readPart(zip, name);
  return buf ? parseXml(decodeXml(buf).text) : null;
}

/** Relationships of `part`: [{ id, type, target }] with targets resolved (external ones left out). */
export function relsOf(zip, part) {
  const relsName = path.posix.join(path.posix.dirname(part), '_rels', `${path.posix.basename(part)}.rels`).replace(/^\.\//, '');
  const doc = xmlPart(zip, relsName);
  return findAll(doc, NS.rel, 'Relationship')
    .filter((r) => attr(r, '', 'TargetMode') !== 'External')
    .map((r) => ({ id: attr(r, '', 'Id'), type: attr(r, '', 'Type') ?? '', target: resolvePart(part, attr(r, '', 'Target')) }));
}

/** The first relationship whose type ends with "/<suffix>". */
export function relOfType(rels, suffix) {
  return rels.find((r) => r.type.endsWith(`/${suffix}`)) ?? null;
}

/** The main part (package relationship officeDocument), else `fallback`. */
export function mainPart(zip, fallback) {
  return relOfType(relsOf(zip, ''), 'officeDocument')?.target ?? fallback;
}
