// The maxDocBytes budget of the attachments of one call: their decoded bytes together,
// apart from the message's own size (which already holds them encoded).
import { DoclinesError } from './errors.js';

export function attachmentBudget(maxDocBytes) {
  let left = maxDocBytes;
  return {
    get left() {
      return left;
    },
    /** Takes one attachment's bytes, or throws too_large when they do not fit. */
    take(name, bytes) {
      if (bytes > left) {
        throw new DoclinesError('too_large', `document too large: ${name} (${bytes} bytes > the ${left} left of maxDocBytes ${maxDocBytes} for attachments)`, { reason: 'document too large' });
      }
      left -= bytes;
    },
  };
}
