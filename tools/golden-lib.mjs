// Shared by make-golden.mjs, golden-private.mjs and test/golden.test.js: what is
// compared between cheap-eyes 0.2 and doclines, and how.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// doclines formats whose output must equal cheap-eyes 0.2 byte for byte.
export const COMPARED = new Set(['text', 'html', 'pdf', 'docx', 'doc', 'rtf']);

// cheap-eyes 0.2 settings that match the doclines defaults (maxTextBytes, maxDocBytes, timeoutMs).
export const CHEAP_EYES_CONFIG = { max_file_bytes: 2097152, max_doc_bytes: 52428800, extract_timeout_s: 60 };

/** readSource of the cheap-eyes 0.2 tree in `dir` (its own node_modules), and its version. */
export async function loadCheapEyes(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  if (pkg.name !== 'cheap-eyes' || !/^0\.2\./.test(pkg.version)) throw new Error(`${dir} is not cheap-eyes 0.2 (found ${pkg.name} ${pkg.version})`);
  const { readSource } = await import(pathToFileURL(path.join(dir, 'src', 'input', 'extract.js')).href);
  return { version: pkg.version, readSource: (file) => readSource(file, { name: path.basename(file), config: CHEAP_EYES_CONFIG }) };
}

// The compared fields of a cheap-eyes 0.2 result (golden file) or a doclines result.
export function viewOfCheapEyes(r) {
  return { format: r.format, charset: r.encoding ?? null, lines: r.lines, markers: r.markers, pageStarts: r.pageStarts, pagesWithoutText: r.pagesWithoutText };
}

export function viewOfDoclines(r) {
  return { format: r.format, charset: r.charset, lines: r.lines, markers: r.markers, pageStarts: r.pageStarts, pagesWithoutText: r.pagesWithoutText };
}

// null when equal, else a short description of the first difference.
export function difference(a, b) {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  for (const k of ['format', 'charset', 'pageStarts', 'pagesWithoutText', 'markers']) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return `${k}: ${JSON.stringify(a[k])} vs ${JSON.stringify(b[k])}`;
  }
  const n = Math.max(a.lines.length, b.lines.length);
  for (let i = 0; i < n; i++) {
    if (a.lines[i] !== b.lines[i]) return `line ${i + 1}: ${JSON.stringify(a.lines[i] ?? null)} vs ${JSON.stringify(b.lines[i] ?? null)} (${a.lines.length} vs ${b.lines.length} lines)`;
  }
  return 'differs';
}
