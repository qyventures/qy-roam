// Postgres timestamps can carry six fractional-second digits while JavaScript
// Date retains only three. The database-issued claim timestamp is also the
// compare-and-swap ownership token, so validate it without normalising it.
export function exactStripeClaimToken(value: unknown) {
  if (typeof value !== 'string' || value.length < 20 || value.length > 64 || value !== value.trim()) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  return Number.isFinite(new Date(value).getTime()) ? value : null;
}
