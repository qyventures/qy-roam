// Retry ledgers are upgraded in place and their counter constraints are
// deliberately NOT VALID so historical rows remain available for review.
// Treat a malformed inherited value as an initial attempt rather than letting
// `NaN`, a negative counter, or an integer overflow strand a paid-order retry.
// PostgreSQL's integer range is also the range used by the ledger columns.
const POSTGRES_INTEGER_MAX = 2_147_483_647;

export function nextRetryAttempt(value: unknown, initialAttempt: number) {
  if (!Number.isSafeInteger(initialAttempt) || initialAttempt < 0 || initialAttempt > POSTGRES_INTEGER_MAX) {
    throw new RangeError('Invalid retry attempt baseline');
  }
  const previous = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(previous) || previous < initialAttempt) return initialAttempt;
  // An inherited counter at the storage ceiling cannot safely increase, but
  // it must not make the delivery/recovery path fail before the actual work is
  // attempted. Keeping the ceiling preserves the ledger's monotonic contract.
  if (previous >= POSTGRES_INTEGER_MAX) return POSTGRES_INTEGER_MAX;
  return previous + 1;
}
