const CANONICAL_POSITIVE_INTEGER = /^[1-9][0-9]*$/;

/**
 * Parse an application/database identifier without JavaScript's permissive
 * numeric coercion. Browser forms may submit IDs as strings, while trusted
 * server data can already be numeric; both forms must identify the same exact
 * positive, safely representable integer.
 */
export function exactPositiveIntegerId(value: unknown) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string' || !CANONICAL_POSITIVE_INTEGER.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && String(parsed) === value ? parsed : null;
}
