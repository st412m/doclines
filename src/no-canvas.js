// pdfjs-dist requires "@napi-rs/canvas" at module load under Node, whether or not it is
// used. Its native binary needs CPU features some hosts lack (no AVX: the process dies
// with SIGILL, which no worker_thread isolation catches). doclines only reads text,
// never renders, so the package is never resolved: pdfjs then takes its own
// `Cannot load "@napi-rs/canvas"` path. Import this module before pdfjs in every thread
// that imports pdfjs: synchronous module hooks are per thread.
import module from 'node:module';

const BLOCKED = /^@napi-rs\/canvas(?:-[^/]*)?(?:\/|$)/;

// Specifiers refused in this thread (tests read it).
export const refused = [];

function deny(specifier) {
  refused.push(specifier);
  const e = new Error(`Cannot find module '${specifier}' (doclines never loads @napi-rs/canvas)`);
  e.code = 'MODULE_NOT_FOUND';
  return e;
}

export function isBlocked(specifier) {
  return BLOCKED.test(specifier);
}

let installed = false;

export function blockCanvas() {
  if (installed) return;
  installed = true;
  if (typeof module.registerHooks === 'function') {
    // Node >= 22.15 / 23.5: covers require() (pdfjs uses createRequire) and import.
    module.registerHooks({
      resolve(specifier, context, nextResolve) {
        if (isBlocked(specifier)) throw deny(specifier);
        return nextResolve(specifier, context);
      },
    });
    return;
  }
  guardResolveFilename(module.Module);
}

// Older Node without module.registerHooks: guard require() resolution.
export function guardResolveFilename(Module) {
  const original = Module._resolveFilename;
  Module._resolveFilename = function resolveFilename(request, ...rest) {
    if (isBlocked(request)) throw deny(request);
    return original.call(this, request, ...rest);
  };
}

blockCanvas();
