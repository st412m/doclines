// Console output in the extraction worker (pdfjs warnings and the like) is collected
// for `result.warnings` instead of being printed. Import first in the worker.
import { format } from 'node:util';

const MAX_LINES = 50;
const MAX_CHARS = 500;
// Notices of the missing canvas package (no-canvas.js): expected, never a warning.
const EXPECTED = /@napi-rs\/canvas|Cannot polyfill `(?:DOMMatrix|ImageData|Path2D)`/;

// Everything printed in this thread, in order (tests read it).
export const captured = [];

for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
  console[m] = (...args) => {
    if (captured.length < 10 * MAX_LINES) captured.push(format(...args));
  };
}

// Captured lines for `result.warnings`: expected notices dropped, repeats once, capped.
export function consoleWarnings() {
  const out = [];
  for (const line of captured) {
    if (EXPECTED.test(line)) continue;
    const s = line.length > MAX_CHARS ? `${line.slice(0, MAX_CHARS)}…` : line;
    if (!out.includes(s)) out.push(s);
    if (out.length === MAX_LINES) break;
  }
  return out;
}
