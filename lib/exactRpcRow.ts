/**
 * Return the sole row from a PostgREST RPC acknowledgement.
 *
 * Supabase can represent a composite RPC result as either the row itself or
 * a one-element array, depending on the function/response shape. Order
 * mutation callers may support both, but must never silently trust the first
 * row of an empty or multi-row response: that would make an ambiguous commit
 * look authoritative before irreversible fulfilment or analytics side effects.
 */
export function exactRpcRow(value: unknown): Record<string, unknown> | null {
  const row = Array.isArray(value)
    ? value.length === 1 ? value[0] : null
    : value;
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  return row as Record<string, unknown>;
}
