// Runs the real extraction worker and reports, with its answer, what reached module
// resolution and what pdfjs printed about @napi-rs. The spy installs no guard of its
// own: its resolve hook is registered first, so the worker's guard (registered later)
// runs before it, and a refused specifier never reaches the spy. `node --test` also
// loads every .mjs under test/ as a test file: on the main thread this does nothing.
import module, { createRequire } from 'node:module';
import { isMainThread, parentPort } from 'node:worker_threads';

if (!isMainThread) {
  const require = createRequire(import.meta.url);
  const seen = [];
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      seen.push(specifier);
      return nextResolve(specifier, context);
    },
  });
  const { captured } = await import('../../src/quiet.js');
  const post = parentPort.postMessage.bind(parentPort);
  parentPort.postMessage = (m) =>
    post({
      ...m,
      spy: {
        resolved: seen.filter((s) => s.includes('@napi-rs')),
        printed: captured.filter((w) => w.includes('@napi-rs')),
        loaded: Object.keys(require.cache).filter((k) => k.includes('@napi-rs')),
      },
    });
  await import('../../src/extract-worker.js');
}
