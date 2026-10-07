// A refusal: the input cannot be turned into lines. `code` is one of CODES; `reason`
// is a short form of the message for skip lists; `label` names the detected format
// for people (e.g. "Excel workbook (.xls)"); `detail` carries the internal error text
// of a `damaged` refusal, which never goes into `message`.
export const CODES = Object.freeze([
  'unsupported',
  'not_allowed',
  'encrypted',
  'no_text_layer',
  'damaged',
  'too_large',
  'text_too_large',
  'timeout',
  'out_of_memory',
  'binary',
  'not_a_file',
]);

export class DoclinesError extends Error {
  constructor(code, message, { format = null, label = null, reason = null, detail = undefined } = {}) {
    super(message);
    this.name = 'DoclinesError';
    this.code = code;
    this.format = format;
    this.label = label;
    this.reason = reason;
    if (detail !== undefined) this.detail = detail;
  }

  // Plain fields for postMessage between threads.
  toJSON() {
    const o = { code: this.code, message: this.message, format: this.format, label: this.label, reason: this.reason };
    if (this.detail !== undefined) o.detail = this.detail;
    return o;
  }

  static from(o) {
    return new DoclinesError(o.code, o.message, o);
  }
}
