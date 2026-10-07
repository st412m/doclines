// pdfjs getTextContent drops every glyph of Unicode category Cf
// (`if (category.isInvisibleFormatMark) continue;` in pdf.worker.mjs). The soft hyphen
// U+00AD is Cf, and a PDF that breaks a word at a line end draws it as a glyph there:
// pdfjs drops it and the word cannot be rejoined. This load hook keeps U+00AD, and only
// it, in pdfjs's worker code. Synchronous module hooks are per thread: import this
// before pdfjs in every thread that imports pdfjs. pdfjs-dist is pinned to the version
// this was written for; with any other code the patch is skipped and reported.
import module, { createRequire } from 'node:module';

const TARGET = /\/pdfjs-dist\/legacy\/build\/pdf\.worker\.mjs$/;
const FROM = 'if (category.isInvisibleFormatMark) {';
const TO = 'if (category.isInvisibleFormatMark && glyph.unicode !== "\\u00ad") {';

// In this thread: whether hooks could be registered, and whether pdfjs's worker code
// was seen and patched.
export const softHyphen = { hooks: typeof module.registerHooks === 'function', seen: false, patched: false };

// The worker source with U+00AD kept; unchanged when the code is not the expected one.
export function patchWorkerSource(source) {
  return source.includes(FROM) ? source.replace(FROM, TO) : source;
}

function pdfjsVersion() {
  try {
    return createRequire(import.meta.url)('pdfjs-dist/package.json').version;
  } catch {
    return 'unknown';
  }
}

// The one-line warning when PDF text was read without the patch, else null.
export function softHyphenWarning(state = softHyphen) {
  if (state.hooks && !(state.seen && !state.patched)) return null;
  return `pdfjs ${pdfjsVersion()} not patched for soft hyphens; words broken at line ends stay split`;
}

let installed = false;

export function keepSoftHyphen() {
  if (installed || !softHyphen.hooks) return;
  installed = true;
  module.registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (!TARGET.test(url)) return result;
      softHyphen.seen = true;
      const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
      const patched = patchWorkerSource(source);
      softHyphen.patched = patched !== source;
      return { ...result, source: patched };
    },
  });
}

keepSoftHyphen();
