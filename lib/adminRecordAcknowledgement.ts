type RecordValue = string | number | boolean | null;

function exactRow(value: unknown): Record<string, unknown> | null {
  const row = Array.isArray(value) ? (value.length === 1 ? value[0] : null) : value;
  return row !== null && typeof row === 'object' && !Array.isArray(row)
    ? row as Record<string, unknown>
    : null;
}

function sameValue(actual: unknown, expected: RecordValue) {
  if (expected === null) return actual === null;
  if (typeof expected === 'number') {
    return typeof actual === 'number' && Number.isFinite(actual) && actual === expected;
  }
  return actual === expected;
}

/**
 * PostgREST mutation responses are an acknowledgement boundary, not merely
 * display data. Require exactly one row, a real database identity, and every
 * caller-selected field to match before an admin action can report success.
 */
export function acknowledgedAdminRecord(
  value: unknown,
  expected: Record<string, RecordValue>,
  expectedId?: number,
) {
  const row = exactRow(value);
  if (!row) return false;
  const id = row.id;
  if (!Number.isSafeInteger(id) || (id as number) < 1) return false;
  if (expectedId !== undefined && id !== expectedId) return false;
  return Object.entries(expected).every(([key, expectedValue]) => sameValue(row[key], expectedValue));
}
