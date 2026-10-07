#!/usr/bin/env node
// doclines <file>: the lines of one document, for debugging and comparing outputs.
// Exit 0 on success, 2 on a refusal (message on stderr), 1 on any other error.
import { parseArgs } from 'node:util';
import { DoclinesError } from './errors.js';
import { detect, extract } from './extract.js';
import { version } from './version.js';

const USAGE = `doclines ${version}

Usage:
  doclines <file> [--json] [--detect] [--formats a,b] [--max-text-bytes N] [--timeout S]

  (default)          numbered lines "L123| text"; section markers unnumbered
  --json             the whole result as JSON
  --detect           the detected format as JSON, nothing extracted
  --formats a,b      allowed format ids (default: all)
  --max-text-bytes N refuse when the extracted text exceeds N bytes
  --timeout S        extraction timeout in seconds
  --version | --help
`;

// Lines with their markers: a marker stands before line `at` (0-based).
function render(r) {
  const out = [];
  let m = 0;
  for (let i = 0; i <= r.lines.length; i++) {
    while (m < r.markers.length && r.markers[m].at === i) out.push(r.markers[m++].text);
    if (i < r.lines.length) out.push(`L${i + 1}| ${r.lines[i]}`);
  }
  return out.join('\n');
}

async function main(argv) {
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        detect: { type: 'boolean' },
        formats: { type: 'string' },
        'max-text-bytes': { type: 'string' },
        timeout: { type: 'string' },
        version: { type: 'boolean' },
        help: { type: 'boolean' },
      },
    });
  } catch (e) {
    process.stderr.write(`${e.message}\n\n${USAGE}`);
    return 1;
  }
  const { values: v, positionals } = args;
  if (v.version) {
    process.stdout.write(`${version}\n`);
    return 0;
  }
  if (v.help || positionals.length !== 1) {
    (v.help ? process.stdout : process.stderr).write(USAGE);
    return v.help ? 0 : 1;
  }
  const file = positionals[0];
  const opts = {};
  if (v.formats) opts.formats = v.formats.split(',').map((s) => s.trim()).filter(Boolean);
  if (v['max-text-bytes'] !== undefined) opts.maxTextBytes = Number(v['max-text-bytes']);
  if (v.timeout !== undefined) opts.timeoutMs = Number(v.timeout) * 1000;
  try {
    if (v.detect) {
      const d = await detect(file, opts);
      process.stdout.write(`${JSON.stringify(d, null, 2)}\n`);
      return d.extractable ? 0 : 2;
    }
    const r = await extract(file, opts);
    process.stdout.write(v.json ? `${JSON.stringify(r, null, 2)}\n` : r.lines.length || r.markers.length ? `${render(r)}\n` : '');
    return 0;
  } catch (e) {
    if (e instanceof DoclinesError) {
      process.stderr.write(`${e.message}\n`);
      return 2;
    }
    process.stderr.write(`doclines: ${e?.message ?? e}\n`);
    return 1;
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
