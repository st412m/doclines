// V8 flags are process-wide: when the host process runs with --max-old-space-size
// (a flag or NODE_OPTIONS), a worker's resourceLimits.maxOldGenerationSizeMb is ignored
// and the worker gets the host's limit. Without the flag a worker's heap limit is
// heapMb plus the young generation: +48 MB on Node 22, +192 MB on Node 24 and on
// Node 22 with --max-semi-space-size=64 (measured on 22.22.2 and 24.21.0, heapMb 16–4096).
// A limit above heapMb + 512 MB means the cap is not in effect; a host limit below that
// gives no warning.
import v8 from 'node:v8';

export const HEAP_SLACK_MB = 512;

export function heapLimitMb() {
  return Math.round(v8.getHeapStatistics().heap_size_limit / 2 ** 20);
}

/** The warning when this thread's heap limit shows that `heapMb` is not in effect, else null. */
export function heapCapWarning(heapMb, limitMb = heapLimitMb()) {
  if (limitMb <= heapMb + HEAP_SLACK_MB) return null;
  return `heap cap of ${heapMb} MB not in effect: the host process sets --max-old-space-size (worker heap limit ${limitMb} MB)`;
}
