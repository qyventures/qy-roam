/**
 * Validate an exact provider count before it becomes an inventory or
 * reporting authority. A missing count is not zero: treating it that way can
 * turn a partial/malformed response into optimistic availability.
 */
export function exactNonnegativeCount(value: unknown, label = 'Exact count') {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} is unavailable or invalid`);
  }
  return value as number;
}
