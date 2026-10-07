// Stand-in for src/extract-worker.js in tests: behaves as `format` says.
// `node --test` also loads every .mjs under test/ as a test file: then it does nothing.
import { isMainThread, parentPort, workerData } from 'node:worker_threads';

const ok = (extra = {}) => ({ ok: true, format: 'html', charset: 'utf-8', lines: ['ok'], markers: [], sections: [], pageStarts: null, pagesWithoutText: [], warnings: [], ...extra });
const { format } = isMainThread ? {} : workerData;
if (format === 'hang') {
  for (;;);
} else if (format === 'internal') {
  parentPort.postMessage({ ok: false, internal: true, message: 'Attempt to access memory outside buffer bounds' });
} else if (format === 'noisy') {
  console.log('worker stdout noise');
  console.info('worker info noise');
  console.warn('worker stderr noise');
  process.stdout.write('raw stdout noise\n');
  process.stderr.write('raw stderr noise\n');
  parentPort.postMessage(ok());
} else if (format === 'captured') {
  // The real worker's console capture: printed lines come back as warnings.
  const { consoleWarnings } = await import('../../src/quiet.js');
  console.log('Warning: TT: undefined function: 32');
  console.warn('Warning: Cannot load "@napi-rs/canvas" package');
  console.log('Warning: TT: undefined function: 32');
  parentPort.postMessage(ok({ warnings: consoleWarnings() }));
} else if (format === 'oom') {
  // When the host's --max-old-space-size overrides the cap, filling the heap would eat
  // the machine: answer with the reason instead.
  const { heapCapWarning } = await import('../../src/heap.js');
  const notInEffect = heapCapWarning(workerData.heapMb);
  if (notInEffect) parentPort.postMessage(ok({ warnings: [notInEffect] }));
  else {
    const keep = [];
    for (;;) keep.push(new Array(1e6).fill(keep.length));
  }
} else if (format === 'crash') {
  process.exit(3);
}
